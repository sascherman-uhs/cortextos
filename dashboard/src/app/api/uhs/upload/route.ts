// JARVIS MOD #47 (2026-07-22) — Cosmos file upload endpoint
// POST multipart/form-data { file: Blob, caption?: string }
// Saves to ~/.cortextos/default/uploads/YYYY-MM-DD/, writes inbox message
// to jarvis-telegram so JARVIS sees the file. Images are forwarded to the
// Telegram bot so they appear in the Telegram chat alongside voice messages.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const AGENT = 'jarvis-telegram';
const TELEGRAM_API = 'https://api.telegram.org';

function getTelegramToken(): string | null {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME || '', '.jarvis-telegram.json'), 'utf-8'),
    );
    return cfg.bot_token || null;
  } catch {
    return null;
  }
}

function getTelegramChatId(): string | null {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME || '', '.jarvis-telegram.json'), 'utf-8'),
    );
    return String(cfg.chat_id || '');
  } catch {
    return null;
  }
}

function deliverToInbox(
  ctxRoot: string,
  text: string,
  filePath: string,
): void {
  const epochMs = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const messageId = `${epochMs}-cosmos-upload-${rand}`;
  const filename = `2-${epochMs}-from-scott-${rand}.json`;
  const inboxDir = path.join(ctxRoot, 'inbox', AGENT);
  const tmpPath = path.join(inboxDir, `.tmp.${filename}`);
  const finalPath = path.join(inboxDir, filename);
  const message = {
    id: messageId,
    from: 'scott',
    to: AGENT,
    priority: 'normal',
    timestamp: new Date().toISOString(),
    text,
    file_path: filePath,
    reply_to: null,
  };
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(message) + '\n');
  fs.renameSync(tmpPath, finalPath);
  // Wake fast-checker
  const pidFile = path.join(ctxRoot, 'state', AGENT, '.fast-checker.pid');
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid > 0) process.kill(pid, 'SIGUSR1');
    } catch { /* fast-checker may not be running */ }
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = formData.get('file') as File | null;
  const caption = (formData.get('caption') as string | null) || '';

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  // Size guard: 50 MB
  if (file.size > 50 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large (50 MB max)' }, { status: 413 });
  }

  // Save to uploads dir
  const today = new Date().toISOString().slice(0, 10);
  const uploadsDir = path.join(process.env.HOME || '', '.cortextos', 'default', 'uploads', today);
  fs.mkdirSync(uploadsDir, { recursive: true });

  // Sanitize filename
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const filePath = path.join(uploadsDir, `${Date.now()}-${safeName}`);

  const bytes = await file.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(bytes));

  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');

  // Build inbox message text
  const captionNote = caption ? ` — Scott says: "${caption}"` : '';
  const inboxText = `Scott shared a file via Cosmos: ${file.name} (${file.type}, ${Math.round(file.size / 1024)}KB)${captionNote}. Saved at: ${filePath}. Please analyze or acknowledge.`;

  const ctxRoot = getCTXRoot();
  try {
    deliverToInbox(ctxRoot, inboxText, filePath);
  } catch (err) {
    console.error('[upload] inbox delivery failed:', err);
  }

  // Forward image/video to Telegram so it shows in chat alongside voice messages
  const botToken = getTelegramToken();
  const chatId = getTelegramChatId();
  let telegramOk = false;
  if (botToken && chatId && (isImage || isVideo)) {
    try {
      const tgForm = new FormData();
      tgForm.append('chat_id', chatId);
      tgForm.append(isImage ? 'photo' : 'video', new Blob([bytes], { type: file.type }), safeName);
      if (caption) tgForm.append('caption', caption);
      const endpoint = isImage ? 'sendPhoto' : 'sendVideo';
      const tgResp = await fetch(`${TELEGRAM_API}/bot${botToken}/${endpoint}`, {
        method: 'POST',
        body: tgForm,
      });
      telegramOk = (await tgResp.json() as { ok?: boolean }).ok === true;
    } catch {
      /* non-fatal — file is in inbox regardless */
    }
  } else if (botToken && chatId) {
    // Non-image: send as document
    try {
      const tgForm = new FormData();
      tgForm.append('chat_id', chatId);
      tgForm.append('document', new Blob([bytes], { type: file.type }), safeName);
      if (caption) tgForm.append('caption', caption);
      const tgResp = await fetch(`${TELEGRAM_API}/bot${botToken}/sendDocument`, {
        method: 'POST',
        body: tgForm,
      });
      telegramOk = (await tgResp.json() as { ok?: boolean }).ok === true;
    } catch { /* non-fatal */ }
  }

  return NextResponse.json({
    success: true,
    filename: safeName,
    path: filePath,
    size: file.size,
    type: file.type,
    telegramForwarded: telegramOk,
  });
}
