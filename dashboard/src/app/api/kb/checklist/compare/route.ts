import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { getOrgDir, getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

const PYTHON = '/opt/homebrew/bin/python3';
const ORG_RE = /^[a-z0-9_-]+$/;

/**
 * POST /api/kb/checklist/compare  { org, collection? }
 *
 * Runs the deterministic coverage comparison (kb_checklist_compare.py) — the
 * same script the nightly CortexOS cron invokes — and returns the summary plus
 * the freshly written `detected` map. Manual confirmations (items[]) are
 * preserved by the script.
 */
export async function POST(req: NextRequest) {
  let body: { org?: string; collection?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const org = body.org || '';
  if (!ORG_RE.test(org)) {
    return NextResponse.json({ error: 'valid org parameter required' }, { status: 400 });
  }
  const collection = body.collection && ORG_RE.test(body.collection) ? body.collection : org;

  const script = path.join(getFrameworkRoot(), 'knowledge-base', 'scripts', 'kb_checklist_compare.py');
  if (!existsSync(script)) {
    return NextResponse.json({ error: 'comparison script not found' }, { status: 500 });
  }

  try {
    const out = execFileSync(
      PYTHON,
      [script, '--org', org, '--collection', collection],
      { timeout: 180_000, encoding: 'utf8', env: { ...process.env, HOME: os.homedir() } },
    );
    const summary = JSON.parse(out.trim().split('\n').slice(-12).join('\n'));

    // Read back the detected map so the client can refresh without a second request.
    const statePath = path.join(getOrgDir(org), 'ideal-kb-checklist.json');
    let detected: Record<string, unknown> = {};
    if (existsSync(statePath)) {
      try {
        detected = JSON.parse(readFileSync(statePath, 'utf-8')).detected || {};
      } catch {
        /* ignore */
      }
    }
    return NextResponse.json({ ...summary, detected });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return NextResponse.json(
      { error: 'comparison failed', detail: (e.stderr || e.message || '').slice(0, 500) },
      { status: 500 },
    );
  }
}
