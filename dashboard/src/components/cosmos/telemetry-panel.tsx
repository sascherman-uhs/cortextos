'use client';

// === JARVIS MOD #82/#83 — Cosmos telemetry: latency sparkline + cost strip (2026-08-03) ===
// New file (cosmos is ours). Two things the fleet has been logging for weeks
// with nowhere to see them (Trillion rubric items 12 "latency instrumented and
// graphed" and 13 "live cost visibility"), scored 5/10 and 2/10 because the
// data existed and the UI didn't.
//
// MOD #82 — latency sparkline: static inline <svg>, no chart library (house
// rule; a CDN chart lib renders blank in half our surfaces anyway). Last 20
// turns, median labelled, dashed marker at the 1s sub-second target.
//
// MOD #83 — cost strip: MTD dollars as the LOUDEST number on the card. Scott
// keeps hard cost caps deliberately visible (memory: hard-cost-caps-stay-loud),
// so this panel exists to make spend easier to see, never to smooth it away —
// no sparklines-instead-of-numbers, no "you're fine" framing, no rounding a
// figure down to look tidy.
//
// Degradation: when the metrics file is absent the card says "no telemetry yet"
// and the median reads "—". It must NEVER print $0.00 for missing data
// (memory: unknown is not zero) — $0.00 is a claim, and it would be a false one.

import { useCallback, useEffect, useState } from 'react';
import { COOL_TEXT, COOL_DIM, COOL_LINE, AQUA, RED } from './palette';
import { DUR_BASE, EASE } from './motion';

interface TurnLatency {
  at: string;
  ms: number;
  engine: string;
  tool: string | null;
  source: 'voice' | 'model';
}

interface ModelSpend {
  model: string;
  pricedAs: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  priceSource: 'table' | 'unverified' | null;
}

interface Telemetry {
  hasData: boolean;
  unavailable?: string;
  latency: { turns: TurnLatency[]; medianMs: number | null; voiceTurns: number };
  cost: {
    models: ModelSpend[];
    totalUsd: number;
    unpricedModels: string[];
    cacheSavingsUsd: number;
    anyUnverified: boolean;
  };
  events: { total: number; errors: number };
}

/** Poll on the same 60s cadence as the stat tiles, and stop while the tab is hidden. */
function useTelemetry(intervalMs: number): Telemetry | null {
  const [data, setData] = useState<Telemetry | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/uhs/telemetry', { cache: 'no-store' });
      if (!res.ok) return;
      setData((await res.json()) as Telemetry);
    } catch {
      // keep the last good frame rather than blanking the panel
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      void load();
      timer = setInterval(() => void load(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    else void load();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, intervalMs]);

  return data;
}

// ---- formatting ------------------------------------------------------------

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Sub-cent spend still gets a real figure — "$0.00" would read as "nothing". */
function fmtUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/** Drop the vendor prefix and date suffix so the row fits: claude-haiku-4-5-2025… → haiku 4.5 */
function shortModel(model: string): string {
  const m = model.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/);
  if (m) return `${m[1]} ${m[2]}.${m[3]}`;
  return model.replace(/-\d{8}$/, '');
}

// ---- MOD #82: sparkline ----------------------------------------------------

const SPARK_W = 130;
const SPARK_H = 30;
/** Trillion's bar: user stops talking → first audible word inside 1s. */
const TARGET_MS = 1000;

function LatencySparkline({ turns, medianMs }: { turns: TurnLatency[]; medianMs: number | null }) {
  if (turns.length < 2 || medianMs === null) {
    return (
      <div className="flex items-center gap-2" data-testid="telemetry-sparkline-empty">
        <span className="font-mono text-sm tabular-nums" style={{ color: COOL_DIM }}>
          —
        </span>
        <span className="text-[10px]" style={{ color: COOL_DIM }}>
          no turns yet
        </span>
      </div>
    );
  }

  // Domain always includes the target line so the marker never sits off-canvas,
  // and always starts at 0 so the shape reads as absolute time, not a zoomed
  // delta that makes a slow run look flat.
  const max = Math.max(TARGET_MS * 1.2, ...turns.map((t) => t.ms));
  const x = (i: number) => (i / (turns.length - 1)) * (SPARK_W - 2) + 1;
  const y = (ms: number) => SPARK_H - 1 - (ms / max) * (SPARK_H - 2);

  const line = turns.map((t, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(t.ms).toFixed(1)}`).join(' ');
  const area = `${line} L${x(turns.length - 1).toFixed(1)},${SPARK_H} L${x(0).toFixed(1)},${SPARK_H} Z`;
  const last = turns[turns.length - 1];
  const overTarget = medianMs > TARGET_MS;

  return (
    <div
      className="flex items-end gap-2.5"
      data-testid="telemetry-sparkline"
      title={`Last ${turns.length} turns. Dashed line = the 1.0s sub-second target. ${turns.filter((t) => t.source === 'voice').length} measured from when Scott stopped talking; the rest are model round-trips on text turns.`}
    >
      <svg
        width={SPARK_W}
        height={SPARK_H}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        aria-hidden="true"
        style={{ overflow: 'visible' }}
      >
        <defs>
          <linearGradient id="cosmos-spark-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={AQUA} stopOpacity="0.26" />
            <stop offset="100%" stopColor={AQUA} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* sub-second target */}
        <line
          x1="0"
          x2={SPARK_W}
          y1={y(TARGET_MS)}
          y2={y(TARGET_MS)}
          stroke={COOL_LINE}
          strokeWidth="1"
          strokeDasharray="2 3"
        />
        <path d={area} fill="url(#cosmos-spark-fill)" />
        <path
          d={line}
          fill="none"
          stroke={AQUA}
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.85"
        />
        {/* most recent turn */}
        <circle cx={x(turns.length - 1)} cy={y(last.ms)} r="2" fill={AQUA} />
      </svg>
      <div className="leading-none">
        {/* Deliberately NOT colour-coded against the target: UHS gold is the one
            warm accent in this scene and MOD #56 reserves it for "listening"
            (Trillion rubric item 3). Over-target is stated in words below
            instead of stealing that accent. */}
        <div
          className="font-mono text-lg font-light tabular-nums"
          style={{ color: COOL_TEXT }}
          data-testid="telemetry-median"
        >
          {fmtSeconds(medianMs)}
        </div>
        <div
          className="mt-1 whitespace-nowrap text-[9px] uppercase tracking-[0.12em]"
          style={{ color: COOL_DIM }}
        >
          {overTarget ? `median · over 1.0s` : `median · under 1.0s`}
        </div>
      </div>
    </div>
  );
}

// ---- MOD #83: cost -------------------------------------------------------

function CostBlock({ cost }: { cost: Telemetry['cost'] }) {
  const priced = cost.models.filter((m) => m.costUsd !== null);
  return (
    <div data-testid="telemetry-cost">
      <div
        className="font-mono text-2xl font-light tabular-nums"
        style={{ color: COOL_TEXT, textShadow: '0 0 16px rgba(94,234,212,0.22)' }}
        data-testid="telemetry-mtd-total"
      >
        {fmtUsd(cost.totalUsd)}
        {cost.anyUnverified && (
          <span
            className="ml-1 align-super text-[10px]"
            style={{ color: RED }}
            title="Includes a list price we have not confirmed against an invoice — treat this total as approximate."
          >
            *
          </span>
        )}
      </div>

      <div className="mt-1.5 space-y-0.5">
        {priced.map((m) => (
          <div
            key={m.model}
            className="flex items-baseline justify-between gap-3 font-mono text-[10px] tabular-nums"
            style={{ color: COOL_DIM }}
            title={`${m.turns} turns · ${fmtTokens(m.inputTokens)} uncached in · ${fmtTokens(m.cacheReadTokens)} cached in · ${fmtTokens(m.outputTokens)} out`}
          >
            <span className="truncate">{shortModel(m.model)}</span>
            <span style={{ color: COOL_TEXT }}>{fmtUsd(m.costUsd ?? 0)}</span>
          </div>
        ))}

        {/* Unpriced models are a HOLE in the total, not a zero — say so out loud. */}
        {cost.unpricedModels.map((model) => (
          <div
            key={model}
            className="flex items-baseline justify-between gap-3 font-mono text-[10px] tabular-nums"
            style={{ color: RED }}
            title="No price in the table — tokens counted, cost not estimated. This spend is NOT in the total above."
            data-testid="telemetry-unpriced"
          >
            <span className="truncate">{shortModel(model)}</span>
            <span>no price</span>
          </div>
        ))}
      </div>

      {cost.cacheSavingsUsd > 0 && (
        <div className="mt-1.5 font-mono text-[10px] tabular-nums" style={{ color: COOL_DIM }} data-testid="telemetry-cache-savings">
          saved {fmtUsd(cost.cacheSavingsUsd)} via cache
        </div>
      )}
    </div>
  );
}

// ---- panel -----------------------------------------------------------------

function PanelBody({ data }: { data: Telemetry | null }) {
  if (data && !data.hasData) {
    return (
      <div className="text-[11px]" style={{ color: COOL_DIM }} data-testid="telemetry-empty">
        No telemetry yet{data.unavailable ? ` — ${data.unavailable}` : ''}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="text-[11px]" style={{ color: COOL_DIM }} data-testid="telemetry-loading">
        Reading metrics…
      </div>
    );
  }
  return (
    <>
      <LatencySparkline turns={data.latency.turns} medianMs={data.latency.medianMs} />
      <div className="my-2.5 h-px" style={{ background: COOL_LINE }} />
      <div className="mb-1 text-[9px] uppercase tracking-[0.18em]" style={{ color: COOL_DIM }}>
        Spend · month to date
      </div>
      <CostBlock cost={data.cost} />
    </>
  );
}

export function TelemetryPanel() {
  const data = useTelemetry(60_000);

  return (
    <>
      {/* Desktop: continues the existing left rail below the stat tiles
          (left-6 at top-24/48/72, each ~5rem tall). Deliberately NOT bottom-left:
          the mic panel is fixed bottom-centre at max-w-xl, so a bottom-left card
          collides with it once the viewport narrows toward the md breakpoint.
          `fixed` because this mounts from cosmos-client, outside the scene's
          positioned container — same result on a full-viewport immersive route. */}
      <div
        data-testid="telemetry-panel"
        className="pointer-events-auto fixed left-6 top-[24.5rem] z-10 hidden w-[15.5rem] rounded-2xl border px-4 py-3 backdrop-blur-xl md:block"
        style={{
          background: 'rgba(16,26,34,0.55)',
          borderColor: COOL_LINE,
          transition: `border-color ${DUR_BASE}ms ${EASE}`,
        }}
      >
        <div className="mb-2 text-[10px] uppercase tracking-[0.18em]" style={{ color: COOL_DIM }}>
          Response · Spend
        </div>
        <PanelBody data={data} />
      </div>

      {/* Mobile: a second compact row under MOD #59's stat-chip strip. Kept above
          the orb's visual centre and well clear of the mic panel at the bottom. */}
      <div
        data-testid="telemetry-panel-mobile"
        className="pointer-events-auto fixed inset-x-0 z-10 flex gap-2 overflow-x-auto px-3 md:hidden"
        style={{ top: 'calc(3.25rem + 3.4rem + env(safe-area-inset-top))', scrollbarWidth: 'none' }}
      >
        <div
          className="shrink-0 rounded-xl border px-3 py-1.5 backdrop-blur-xl"
          style={{ background: 'rgba(16,26,34,0.55)', borderColor: COOL_LINE }}
        >
          <div className="text-[9px] uppercase tracking-[0.16em] whitespace-nowrap" style={{ color: COOL_DIM }}>
            Median reply
          </div>
          <div className="font-mono text-base font-light leading-tight tabular-nums" style={{ color: COOL_TEXT }}>
            {data?.latency.medianMs != null ? fmtSeconds(data.latency.medianMs) : '—'}
          </div>
        </div>
        <div
          className="shrink-0 rounded-xl border px-3 py-1.5 backdrop-blur-xl"
          style={{ background: 'rgba(16,26,34,0.55)', borderColor: COOL_LINE }}
        >
          <div className="text-[9px] uppercase tracking-[0.16em] whitespace-nowrap" style={{ color: COOL_DIM }}>
            Spend MTD
          </div>
          <div
            className="font-mono text-base font-light leading-tight tabular-nums"
            style={{ color: COOL_TEXT }}
            data-testid="telemetry-mtd-mobile"
          >
            {data?.hasData ? fmtUsd(data.cost.totalUsd) : '—'}
          </div>
        </div>
      </div>
    </>
  );
}
// === END JARVIS MOD #82/#83 ===
