// === JARVIS MOD #81 — /api/uhs/telemetry (2026-08-03) ===
// New file in the api/uhs/ local-mod isolation zone. Session-authed GET that
// reads the fast-path metrics JSONL and returns (a) recent turn latencies,
// (b) month-to-date tokens per model split cached/uncached, (c) estimated MTD
// cost, (d) cache savings. All parsing + money math lives in
// @/lib/uhs/telemetry (pure + unit-tested); this file only does auth, fs, and
// the 30s cache.
//
// Degradation follows the cosmos-stats pattern: a missing or rotated metrics
// file is NOT an error — it returns hasData:false with an `unavailable` reason
// so the panel prints "no telemetry yet" rather than a fabricated $0.00
// (memory rule: unknown is not zero).
import { auth } from '@/lib/auth';
import { getLogDir } from '@/lib/config';
import { computeTelemetry, parseMetricsLines, type TelemetryReport } from '@/lib/uhs/telemetry';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// jarvis-telegram is the agent that actually serves Scott's turns; the others
// have no fastpath-metrics.jsonl today. Extra agents are read opportunistically
// so a future lane that starts logging shows up without another mod.
const AGENTS = ['jarvis-telegram', 'jarvis-orchestrator', 'jarvis-heartbeat'];
const METRICS_FILE = 'fastpath-metrics.jsonl';

// The panel polls at 60s; a 30s server cache means two clients never double-read
// the file but a manual refresh still feels live.
const CACHE_MS = 30_000;
let cache: { at: number; body: TelemetryResponse } | null = null;

type TelemetryResponse = TelemetryReport & {
  unavailable?: string;
  sources: string[];
};

async function readAgentMetrics(agent: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(getLogDir(agent), METRICS_FILE), 'utf-8');
  } catch {
    // Missing file / rotated away / no permission — this agent simply has no
    // telemetry. Not an error condition.
    return null;
  }
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return Response.json(cache.body);
  }

  const reads = await Promise.all(AGENTS.map(readAgentMetrics));
  const sources: string[] = [];
  const events = [];
  for (let i = 0; i < AGENTS.length; i++) {
    const raw = reads[i];
    if (raw === null) continue;
    const parsed = parseMetricsLines(raw);
    if (parsed.length === 0) continue;
    sources.push(AGENTS[i]);
    events.push(...parsed);
  }

  const report = computeTelemetry(events);
  const body: TelemetryResponse = { ...report, sources };
  if (!report.hasData) {
    body.unavailable = sources.length === 0 ? 'no metrics file' : 'no events logged';
  }

  cache = { at: Date.now(), body };
  return Response.json(body);
}
// === END JARVIS MOD #81 ===
