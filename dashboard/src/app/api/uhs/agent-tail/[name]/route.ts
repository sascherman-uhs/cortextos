// === JARVIS MOD #22 — Cosmos Tier 4: per-agent stdout tail (2026-07-03) ===
// New file in the api/uhs/ local-mod isolation zone. Session-authed GET that
// returns the last ~5 lines of an agent's stdout.log so the orbit side-panel
// can show what the agent is doing right now. Mirrors the auth + name-validation
// shape of the sibling wake route, and the ANSI/control-char stripping of the
// upstream api/agents/[name]/logs route.
import { auth } from '@/lib/auth';
import { getLogDir } from '@/lib/config';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_NAME = /^[a-z0-9_-]+$/;
// Only read the tail of the file; agent stdout logs grow to tens of MB.
const READ_BYTES = 64 * 1024;
const DEFAULT_LINES = 5;
const MAX_LINES = 40;
// Interactive (Claude Code TUI) logs are often one giant line with no real
// newlines. Cap each returned line and the whole payload so the side panel
// stays readable and the response stays small.
const MAX_LINE_CHARS = 240;
const MAX_TOTAL_CHARS = 4_000;

function stripLogNoise(raw: string): string {
  return raw
    .replace(
      // eslint-disable-next-line no-control-regex
      /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[\?]?[0-9;]*[a-zA-Z]/g,
      '',
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\r/g, '');
}

// ---------------------------------------------------------------------------
// GET /api/uhs/agent-tail/[name]?lines=5 - last N lines of stdout.log
// ---------------------------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { name } = await params;
  const decoded = decodeURIComponent(name);
  if (!VALID_NAME.test(decoded)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  const url = new URL(request.url);
  const lines = Math.min(
    Math.max(Number(url.searchParams.get('lines') ?? DEFAULT_LINES) || DEFAULT_LINES, 1),
    MAX_LINES,
  );

  const logFile = path.join(getLogDir(decoded), 'stdout.log');

  try {
    // Read only the trailing READ_BYTES so we never load a multi-MB log.
    const handle = await fs.open(logFile, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - READ_BYTES);
      const length = size - start;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      const cleaned = stripLogNoise(buf.toString('utf-8'));
      // Split on real newlines first; then hard-wrap any over-long "line"
      // (TUI logs) so a single newline-free blob still yields readable rows.
      const rows: string[] = [];
      for (const raw of cleaned.split('\n')) {
        const line = raw.trim().replace(/\s+/g, ' ');
        if (!line) continue;
        if (line.length <= MAX_LINE_CHARS) {
          rows.push(line);
        } else {
          for (let i = 0; i < line.length; i += MAX_LINE_CHARS) {
            rows.push(line.slice(i, i + MAX_LINE_CHARS));
          }
        }
      }
      let tail = rows.slice(-lines);
      // Final total-size guard.
      while (tail.join('\n').length > MAX_TOTAL_CHARS && tail.length > 1) {
        tail = tail.slice(1);
      }
      return Response.json({ agent: decoded, lines: tail });
    } finally {
      await handle.close();
    }
  } catch {
    // No log yet (or unreadable) — degrade to empty, not an error, so the
    // panel just shows "no recent output".
    return Response.json({ agent: decoded, lines: [] });
  }
}
// === END JARVIS MOD #22 ===
