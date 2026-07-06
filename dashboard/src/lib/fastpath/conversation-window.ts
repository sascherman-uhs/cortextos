// cortextOS Dashboard — Cosmos fast-path conversation window (JARVIS MOD #34, B3)
//
// Working memory for the fast path. Instead of a separate store, the window is
// derived from the SAME logs the app chat history uses — inbound-messages.jsonl
// ([Cosmos]-tagged user turns) and outbound-messages.jsonl (all agent replies,
// fast-path AND full-agent). That keeps the fast path coherent with turns the
// full agent handled, survives restarts for free, and adds no new state files.
// (Deviation from plan B3's dedicated store, documented in the plan file.)

import fs from 'fs';
import path from 'path';
import { getLogDir } from '@/lib/config';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  ts: number; // epoch ms, for ordering
}

const COSMOS_PREFIX = '[Cosmos]';

function readTailLines(file: string, maxBytes = 256 * 1024): string[] {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n');
    // First line may be a partial record when we started mid-file
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } catch {
    return [];
  }
}

/**
 * Build a bounded, alternating-safe message window for the API call.
 * Only [Cosmos]-tagged inbound turns are included on the user side — this lane
 * is the Cosmos voice channel, not Telegram.
 */
export function buildWindow(agent: string, maxTurns = 20): Turn[] {
  const logDir = getLogDir(agent);
  const turns: Turn[] = [];

  for (const line of readTailLines(path.join(logDir, 'inbound-messages.jsonl'))) {
    try {
      const j = JSON.parse(line);
      const text = String(j.text ?? '');
      if (!text.startsWith(COSMOS_PREFIX)) continue;
      const ts = Date.parse(j.timestamp ?? '') || 0;
      turns.push({ role: 'user', content: text.slice(COSMOS_PREFIX.length).trim(), ts });
    } catch { /* skip bad lines */ }
  }

  for (const line of readTailLines(path.join(logDir, 'outbound-messages.jsonl'))) {
    try {
      const j = JSON.parse(line);
      const ts = Date.parse(j.timestamp ?? '') || 0;
      const text = String(j.text ?? '').trim();
      if (text) turns.push({ role: 'assistant', content: text, ts });
    } catch { /* skip bad lines */ }
  }

  turns.sort((a, b) => a.ts - b.ts);
  const recent = turns.slice(-maxTurns);

  // Anthropic requires alternating roles starting with 'user': merge
  // consecutive same-role turns and drop a leading assistant turn.
  const merged: Turn[] = [];
  for (const t of recent) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) {
      last.content += '\n' + t.content;
      last.ts = t.ts;
    } else {
      merged.push({ ...t });
    }
  }
  while (merged.length && merged[0].role === 'assistant') merged.shift();
  return merged;
}
