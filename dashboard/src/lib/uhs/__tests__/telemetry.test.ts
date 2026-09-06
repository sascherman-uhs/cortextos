// === JARVIS MOD #80 tests — telemetry parser + cost math ===
// The money math is the reason this file exists: a wrong multiplier here shows
// Scott a wrong MTD number and he has no way to catch it from the UI. Every
// dollar assertion below is computed by hand from MODEL_PRICES, not from the
// implementation.
import { describe, it, expect } from 'vitest';
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  computeTelemetry,
  median,
  parseMetricsLines,
  priceFor,
  recentLatencies,
} from '../telemetry';

const NOW = new Date('2026-08-03T16:00:00.000Z');

function reply(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    timestamp: '2026-08-02T10:00:00.000Z',
    event: 'reply',
    model: 'claude-haiku-4-5-20251001',
    latencyMs: 1500,
    input_tokens: 1000,
    output_tokens: 100,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  });
}

describe('parseMetricsLines', () => {
  it('parses well-formed lines and ignores blanks', () => {
    const raw = `${reply()}\n\n${reply({ event: 'escalate' })}\n`;
    const events = parseMetricsLines(raw);
    expect(events).toHaveLength(2);
    expect(events[1].event).toBe('escalate');
  });

  it('skips a truncated final line instead of throwing', () => {
    const raw = `${reply()}\n{"timestamp":"2026-08-02T10:0`;
    expect(parseMetricsLines(raw)).toHaveLength(1);
  });

  it('skips lines missing timestamp or event', () => {
    const raw = ['{"event":"reply"}', '{"timestamp":"2026-08-02T10:00:00.000Z"}', reply()].join('\n');
    expect(parseMetricsLines(raw)).toHaveLength(1);
  });

  it('returns [] for an empty file', () => {
    expect(parseMetricsLines('')).toEqual([]);
    expect(parseMetricsLines('\n\n')).toEqual([]);
  });
});

describe('priceFor', () => {
  it('matches a dated model id by alias prefix', () => {
    expect(priceFor('claude-haiku-4-5-20251001')?.key).toBe('claude-haiku-4-5');
  });

  it('matches an exact alias', () => {
    expect(priceFor('claude-sonnet-4-6')?.key).toBe('claude-sonnet-4-6');
  });

  it('returns null for an unknown model rather than falling back to a price', () => {
    expect(priceFor('some-future-model-9')).toBeNull();
  });
});

describe('median', () => {
  it('returns null on an empty set (never 0)', () => {
    expect(median([])).toBeNull();
  });
  it('handles odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(3); // (2+3)/2 rounded
  });
});

describe('recentLatencies', () => {
  it('prefers turn_latency for the voice clock and tags the source', () => {
    const events = parseMetricsLines(
      JSON.stringify({
        timestamp: '2026-08-03T15:18:55.921Z',
        event: 'turn_latency',
        voice_path: 'realtime',
        time_since_user_stopped_talking_ms: 842,
        tool: 'calendar_today',
      }),
    );
    const [turn] = recentLatencies(events);
    expect(turn).toMatchObject({ ms: 842, engine: 'realtime', tool: 'calendar_today', source: 'voice' });
  });

  it('includes model round-trips and labels escalations distinctly', () => {
    const events = parseMetricsLines([reply(), reply({ event: 'escalate', latencyMs: 700 })].join('\n'));
    const turns = recentLatencies(events);
    expect(turns.map((t) => t.engine)).toEqual(['fastpath', 'escalated']);
    expect(turns.every((t) => t.source === 'model')).toBe(true);
  });

  it('returns oldest-first and caps at the limit', () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      reply({ timestamp: `2026-08-02T10:${String(i).padStart(2, '0')}:00.000Z`, latencyMs: i }),
    );
    const turns = recentLatencies(parseMetricsLines(lines.join('\n')), 20);
    expect(turns).toHaveLength(20);
    expect(turns[0].ms).toBe(10);
    expect(turns[19].ms).toBe(29);
  });

  it('drops events with a non-numeric latency', () => {
    const events = parseMetricsLines(reply({ latencyMs: null }));
    expect(recentLatencies(events)).toHaveLength(0);
  });
});

describe('computeTelemetry — cost math', () => {
  it('bills input, output, cache reads and cache writes at the documented rates', () => {
    // Haiku 4.5 = $1/MTok in, $5/MTok out. 1M input + 1M output + 1M cache-read
    // + 1M cache-write = 1 + 5 + 0.1 + 1.25 = $7.35
    const events = parseMetricsLines(
      reply({
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      }),
    );
    const report = computeTelemetry(events, NOW);
    expect(report.cost.totalUsd).toBeCloseTo(7.35, 10);
    expect(report.cost.models[0].priceSource).toBe('table');
  });

  it('counts escalations — the Haiku call still ran and still cost money', () => {
    const events = parseMetricsLines(reply({ event: 'escalate', input_tokens: 1_000_000, output_tokens: 0 }));
    expect(computeTelemetry(events, NOW).cost.totalUsd).toBeCloseTo(1.0, 10);
  });

  it('computes cache savings as the uncached-minus-cached delta', () => {
    // 1M cache-read tokens on Haiku: uncached $1.00, cached $0.10 → saved $0.90
    const events = parseMetricsLines(
      reply({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }),
    );
    const report = computeTelemetry(events, NOW);
    expect(report.cost.cacheSavingsUsd).toBeCloseTo(0.9, 10);
    expect(1 - CACHE_READ_MULTIPLIER).toBe(0.9);
    expect(CACHE_WRITE_MULTIPLIER).toBe(1.25);
  });

  it('reports tokens WITHOUT a cost for an unknown model (never guesses a rate)', () => {
    const events = parseMetricsLines(reply({ model: 'mystery-model-1', input_tokens: 5000 }));
    const report = computeTelemetry(events, NOW);
    const row = report.cost.models[0];
    expect(row.inputTokens).toBe(5000);
    expect(row.costUsd).toBeNull();
    expect(row.priceSource).toBeNull();
    expect(report.cost.unpricedModels).toEqual(['mystery-model-1']);
    expect(report.cost.totalUsd).toBe(0); // the priced total, with the gap surfaced separately
  });

  it('flags unverified list prices so the UI can mark them', () => {
    const events = parseMetricsLines(reply({ model: 'gpt-realtime', input_tokens: 1_000_000, output_tokens: 0 }));
    const report = computeTelemetry(events, NOW);
    expect(report.cost.models[0].priceSource).toBe('unverified');
    expect(report.cost.anyUnverified).toBe(true);
  });

  it('excludes events from previous months from the MTD rollup', () => {
    const events = parseMetricsLines(
      [
        reply({ timestamp: '2026-07-15T10:00:00.000Z', input_tokens: 9_000_000 }),
        reply({ timestamp: '2026-08-02T10:00:00.000Z', input_tokens: 1_000_000, output_tokens: 0 }),
      ].join('\n'),
    );
    const report = computeTelemetry(events, NOW);
    expect(report.cost.models[0].inputTokens).toBe(1_000_000);
    expect(report.cost.totalUsd).toBeCloseTo(1.0, 10);
  });

  it('aggregates turns per model and splits cached vs uncached', () => {
    const events = parseMetricsLines(
      [
        reply({ input_tokens: 100, cache_read_input_tokens: 8000 }),
        reply({ input_tokens: 200, cache_read_input_tokens: 8000 }),
      ].join('\n'),
    );
    const row = computeTelemetry(events, NOW).cost.models[0];
    expect(row.turns).toBe(2);
    expect(row.inputTokens).toBe(300);
    expect(row.cacheReadTokens).toBe(16000);
  });

  it('counts error events without letting them touch the cost math', () => {
    const events = parseMetricsLines(
      [reply(), JSON.stringify({ timestamp: '2026-08-02T11:00:00.000Z', event: 'error', latencyMs: 268, error: 'fetch failed' })].join('\n'),
    );
    const report = computeTelemetry(events, NOW);
    expect(report.events.errors).toBe(1);
    expect(report.cost.models).toHaveLength(1);
  });
});

describe('computeTelemetry — missing data degrades honestly', () => {
  it('reports hasData:false for an empty log so the UI can say "no telemetry yet"', () => {
    const report = computeTelemetry([], NOW);
    expect(report.hasData).toBe(false);
    expect(report.latency.medianMs).toBeNull(); // null, NOT 0
    expect(report.cost.models).toEqual([]);
  });

  it('still reports hasData:true when the month has no spend but the log exists', () => {
    // Everything is from last month: there IS telemetry, this month's spend is
    // genuinely zero — a different statement from "we don't know".
    const events = parseMetricsLines(reply({ timestamp: '2026-07-15T10:00:00.000Z' }));
    const report = computeTelemetry(events, NOW);
    expect(report.hasData).toBe(true);
    expect(report.cost.totalUsd).toBe(0);
  });
});
