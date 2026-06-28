import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

const PYTHON = '/opt/homebrew/bin/python3';
const MMRAG = `${os.homedir()}/.claude/skills/multimodal-rag/scripts/mmrag.py`;
const VAULT_INBOX = `${os.homedir()}/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS/vault/inbox`;

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.docx', '.txt', '.md', '.html', '.htm', '.png', '.jpg', '.jpeg',
  '.pptx', '.xlsx', '.mp4', '.mp3', '.wav',
]);

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const classification = (formData.get('classification') as string) || 'internal';
    const collection = (formData.get('collection') as string) || 'uhs';

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        { error: `File type ${ext} not supported. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` },
        { status: 400 }
      );
    }

    // classification must be 'internal' or 'external'
    if (!['internal', 'external'].includes(classification)) {
      return NextResponse.json({ error: 'classification must be internal or external' }, { status: 400 });
    }

    // Save to vault/inbox/<classification>/
    const targetDir = path.join(VAULT_INBOX, classification);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const targetPath = path.join(targetDir, file.name);
    const bytes = await file.arrayBuffer();
    writeFileSync(targetPath, Buffer.from(bytes));

    // Ingest into mmrag
    let ingestOutput = '';
    let chunksAdded = 0;
    let success = false;

    try {
      ingestOutput = execFileSync(PYTHON, [MMRAG, 'ingest', targetPath, '--collection', collection], {
        timeout: 120_000,
        encoding: 'utf8',
      });
      // Parse "Done! Ingested N new chunk(s)"
      const match = ingestOutput.match(/Ingested (\d+) new chunk/);
      chunksAdded = match ? parseInt(match[1], 10) : 0;
      success = true;
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      ingestOutput = (error.stdout || '') + (error.stderr || error.message || '');
      success = false;
    }

    return NextResponse.json({
      success,
      filename: file.name,
      classification,
      collection,
      savedTo: targetPath,
      chunksAdded,
      output: ingestOutput.slice(0, 500),
    });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ error: error.message || 'Ingest failed' }, { status: 500 });
  }
}
