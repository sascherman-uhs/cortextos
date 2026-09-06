// === JARVIS MOD #80 — fastpath telemetry: JSONL parser + cost math (2026-08-03) ===
// New file in the uhs/ local-mod zone. Pure functions only (no fs, no fetch) so
// the parser and the money math are unit-testable without a filesystem; the
// route in api/uhs/telemetry does the reading and the auth.
//
// Source of truth: ~/.cortextos/default/logs/<agent>/fastpath-metrics.jsonl,
// one JSON object per line, written by the Haiku fast path (MOD #34/#38) and by
// the voice lanes (MOD #54). Four event shapes exist today:
//   reply        — fast lane answered.   model, latencyMs, *_tokens
//   escalate     — fast lane deferred.   same fields (the Haiku call still ran
//                                        and still cost money — count it)
//   error        — latencyMs + error string, no tokens
//   turn_latency — voice_path, time_since_user_stopped_talking_ms, tool
//
// Honesty rules baked in (memory: "unknown is not zero", "hard cost caps stay
// loud"): a model with no price-table entry returns its token counts with
// cost === null rather than a guessed dollar figure, and an absent/empty file
// returns hasData:false so the UI can say "no telemetry yet" instead of "$0.00".

/** One parsed line. Unknown event names are kept so counts stay honest. */
export interface MetricEvent {
  timestamp: string;
  event: string;
  model?: string;
  latencyMs?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  voice_path?: string;
  time_since_user_stopped_talking_ms?: number;
  tool?: string;
}

/**
 * Per-MTok list prices. ONE constant — every dollar figure in the UI traces here.
 *
 * Anthropic (verified 2026-08-03 against the published model table): cache READS
 * bill at 0.1x the input rate, cache WRITES at 1.25x (5-minute TTL, which is what
 * the fast path uses). Those multipliers are the same across Claude models, so
 * they live once below rather than per row.
 *
 * `unverified: true` means the row is a best-known list price we have NOT
 * confirmed against an invoice — the API tags its cost `priceSource:'unverified'`
 * and the panel is expected to mark it. gpt-realtime is text-rate only; its audio
 * tokens bill far higher, and the realtime lane does not log token counts today,
 * so this row is dormant (kept so a future MOD that starts logging them lands on
 * a real number instead of silently dropping the spend).
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

export interface ModelPrice {
  /** USD per million input tokens. */
  inPerMTok: number;
  /** USD per million output tokens. */
  outPerMTok: number;
  unverified?: boolean;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-4-5': { inPerMTok: 1.0, outPerMTok: 5.0 },
  'claude-sonnet-4-6': { inPerMTok: 3.0, outPerMTok: 15.0 },
  'gpt-realtime': { inPerMTok: 4.0, outPerMTok: 16.0, unverified: true },
};

/**
 * Log lines carry dated model ids (`claude-haiku-4-5-20251001`); the price table
 * is keyed by the alias. Longest matching prefix wins so a future
 * `claude-haiku-4-5-1m` style id can get its own row without breaking this one.
 */
export function priceFor(model: string): { key: string; price: ModelPrice } | null {
  if (MODEL_PRICES[model]) return { key: model, price: MODEL_PRICES[model] };
  let best: string | null = null;
  for (const key of Object.keys(MODEL_PRICES)) {
    if (model.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  return best ? { key: best, price: MODEL_PRICES[best] } : null;
}

/** Tolerant line-by-line parse: a truncated tail line (mid-write) is skipped, not fatal. */
export function parseMetricsLines(raw: string): MetricEvent[] {
  const out: MetricEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const ts = obj.timestamp;
      const ev = obj.event;
      if (typeof ts !== 'string' || typeof ev !== 'string') continue;
      out.push(obj as unknown as MetricEvent);
    } catch {
      // Not JSON (or a half-written final line) — ignore.
    }
  }
  return out;
}

// ---- latency ---------------------------------------------------------------

export interface TurnLatency {
  at: string;
  ms: number;
  /** Which lane produced it: the realtime/legacy voice path, or the Haiku text fast path. */
  engine: string;
  /** Fast-lane tool that answered the turn, when one did. */
  tool: string | null;
  /**
   * `voice` = time_since_user_stopped_talking (the Trillion metric).
   * `model` = model round-trip on a text turn. Both are "how long until Jarvis
   * answered", but they are NOT the same clock — the UI must label the mix.
   */
  source: 'voice' | 'model';
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Last `limit` turns, oldest-first (sparkline draws left→right in time order). */
export function recentLatencies(events: MetricEvent[], limit = 20): TurnLatency[] {
  const turns: TurnLatency[] = [];
  for (const e of events) {
    if (e.event === 'turn_latency') {
      const ms = e.time_since_user_stopped_talking_ms;
      if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
      turns.push({
        at: e.timestamp,
        ms,
        engine: e.voice_path ?? 'voice',
        tool: e.tool ?? null,
        source: 'voice',
      });
    } else if (e.event === 'reply' || e.event === 'escalate') {
      const ms = e.latencyMs;
      if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
      turns.push({
        at: e.timestamp,
        ms,
        engine: e.event === 'reply' ? 'fastpath' : 'escalated',
        tool: e.tool ?? null,
        source: 'model',
      });
    }
  }
  turns.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return turns.slice(-limit);
}

// ---- cost ------------------------------------------------------------------

export interface ModelSpend {
  model: string;
  /** Price-table key this matched, or null when the model is unpriced. */
  pricedAs: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null = no price row. Tokens are still reported; we never guess a rate. */
  costUsd: number | null;
  /** null when unpriced; 'unverified' flags a list price we haven't confirmed. */
  priceSource: 'table' | 'unverified' | null;
}

export interface TelemetryReport {
  /** false when the metrics file is missing/empty — the UI must NOT render $0. */
  hasData: boolean;
  periodStart: string;
  generatedAt: string;
  latency: {
    turns: TurnLatency[];
    medianMs: number | null;
    /** Turns whose clock is the voice metric (vs. model round-trip). */
    voiceTurns: number;
  };
  cost: {
    models: ModelSpend[];
    totalUsd: number;
    /** Models seen in-period with no price row — surfaced, never silently dropped. */
    unpricedModels: string[];
    /** What the cache-read tokens would have cost at full input rate, minus what they did cost. */
    cacheSavingsUsd: number;
    /** Any spend figure includes at least one unverified list price. */
    anyUnverified: boolean;
  };
  events: { total: number; errors: number };
}

function tok(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Month-to-date rollup. `now` is injectable so tests don't depend on the clock.
 * MTD boundary is local-month start (matches how Scott reads a bill), not UTC.
 */
export function computeTelemetry(
  events: MetricEvent[],
  now: Date = new Date(),
  latencyLimit = 20,
): TelemetryReport {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const inMonth = events.filter((e) => {
    const t = Date.parse(e.timestamp);
    return Number.isFinite(t) && t >= monthStart;
  });

  const byModel = new Map<string, ModelSpend>();
  let errors = 0;

  for (const e of inMonth) {
    if (e.event === 'error') errors++;
    if (e.event !== 'reply' && e.event !== 'escalate') continue;
    const model = e.model;
    if (!model) continue;

    let row = byModel.get(model);
    if (!row) {
      const matched = priceFor(model);
      row = {
        model,
        pricedAs: matched?.key ?? null,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: matched ? 0 : null,
        priceSource: matched ? (matched.price.unverified ? 'unverified' : 'table') : null,
      };
      byModel.set(model, row);
    }
    row.turns++;
    row.inputTokens += tok(e.input_tokens);
    row.outputTokens += tok(e.output_tokens);
    row.cacheReadTokens += tok(e.cache_read_input_tokens);
    row.cacheWriteTokens += tok(e.cache_creation_input_tokens);
  }

  let totalUsd = 0;
  let cacheSavingsUsd = 0;
  let anyUnverified = false;
  const unpricedModels: string[] = [];

  for (const row of byModel.values()) {
    const matched = row.pricedAs ? MODEL_PRICES[row.pricedAs] : null;
    if (!matched) {
      unpricedModels.push(row.model);
      continue;
    }
    if (matched.unverified) anyUnverified = true;
    const inRate = matched.inPerMTok / 1_000_000;
    const outRate = matched.outPerMTok / 1_000_000;
    const cost =
      row.inputTokens * inRate +
      row.outputTokens * outRate +
      row.cacheReadTokens * inRate * CACHE_READ_MULTIPLIER +
      row.cacheWriteTokens * inRate * CACHE_WRITE_MULTIPLIER;
    row.costUsd = cost;
    totalUsd += cost;
    // What those cached reads would have cost uncached, minus what they did cost.
    cacheSavingsUsd += row.cacheReadTokens * inRate * (1 - CACHE_READ_MULTIPLIER);
  }

  const turns = recentLatencies(events, latencyLimit);

  return {
    hasData: events.length > 0,
    periodStart: new Date(monthStart).toISOString(),
    generatedAt: now.toISOString(),
    latency: {
      turns,
      medianMs: median(turns.map((t) => t.ms)),
      voiceTurns: turns.filter((t) => t.source === 'voice').length,
    },
    cost: {
      models: [...byModel.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
      totalUsd,
      unpricedModels,
      cacheSavingsUsd,
      anyUnverified,
    },
    events: { total: inMonth.length, errors },
  };
}
// === END JARVIS MOD #80 ===
