import { NextRequest, NextResponse } from 'next/server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { getOrgDir } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Ideal KB Checklist state — per-org persistence.
 *
 * Tracks which documents from the north-star home-staging taxonomy
 * (src/data/ideal-kb-taxonomy.json) have been added to the knowledge base.
 *
 * Two layers:
 *  - items[docId]    -> manual confirmation ({ done, note?, updatedAt }).
 *                       Human-confirmed coverage. Always wins.
 *  - detected[docId] -> automated nightly detection ({ source, score, detectedAt }).
 *                       A *suggestion* surfaced by kb_checklist_compare.py; the
 *                       user confirms it (which writes an items[] entry).
 *
 * GET  /api/kb/checklist?org=<org>                  -> { items, detected }
 * POST /api/kb/checklist  { org, id, done, note? }  -> { ok, items, detected }
 *
 * State file: <CTX_ROOT>/orgs/<org>/ideal-kb-checklist.json
 */

interface ChecklistItem {
  done: boolean;
  note?: string;
  updatedAt: string;
}
interface DetectedItem {
  source: string;
  score: number;
  detectedAt: string;
}
interface ChecklistState {
  items: Record<string, ChecklistItem>;
  detected: Record<string, DetectedItem>;
}

const ORG_RE = /^[a-z0-9_-]+$/;

function statePath(org: string): string {
  return path.join(getOrgDir(org), 'ideal-kb-checklist.json');
}

function readState(org: string): ChecklistState {
  const empty: ChecklistState = { items: {}, detected: {} };
  const p = statePath(org);
  if (!existsSync(p)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      items: parsed.items && typeof parsed.items === 'object' ? parsed.items : {},
      detected: parsed.detected && typeof parsed.detected === 'object' ? parsed.detected : {},
    };
  } catch {
    return empty;
  }
}

function writeState(org: string, state: ChecklistState): void {
  const p = statePath(org);
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

export async function GET(req: NextRequest) {
  const org = req.nextUrl.searchParams.get('org') || '';
  if (!ORG_RE.test(org)) {
    return NextResponse.json({ error: 'valid org parameter required' }, { status: 400 });
  }
  const state = readState(org);
  return NextResponse.json({ items: state.items, detected: state.detected });
}

export async function POST(req: NextRequest) {
  let body: { org?: string; id?: string; done?: boolean; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const org = body.org || '';
  const id = body.id || '';
  if (!ORG_RE.test(org)) {
    return NextResponse.json({ error: 'valid org parameter required' }, { status: 400 });
  }
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  const state = readState(org);
  const done = !!body.done;
  const note = typeof body.note === 'string' ? body.note : state.items[id]?.note;

  // Drop the entry entirely when it returns to the default (outstanding, no note)
  // so the state file stays a compact record of only what has changed.
  if (!done && !note) {
    delete state.items[id];
  } else {
    state.items[id] = { done, ...(note ? { note } : {}), updatedAt: new Date().toISOString() };
  }

  writeState(org, state);
  return NextResponse.json({ ok: true, items: state.items, detected: state.detected });
}
