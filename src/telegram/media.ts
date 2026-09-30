/**
 * Telegram media message handling.
 * Downloads and processes photo, document, audio, voice, video, and video_note messages.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TelegramAPI } from './api.js';
import { transcribeVoice } from './transcribe.js';
import { TelegramMessage } from '../types/index.js';
import { ensureDir } from '../utils/atomic.js';

export interface ProcessedMedia {
  type: 'photo' | 'document' | 'audio' | 'voice' | 'video' | 'video_note';
  chat_id: number;
  from: string;
  text: string;
  date: number;
  image_path?: string;
  file_path?: string;
  file_name?: string;
  duration?: number;
  transcript?: string;
}

/**
 * Sanitize a filename by stripping unsafe characters.
 * Keeps only a-zA-Z0-9._- and limits to 200 chars.
 * Returns "unnamed_file" if result is empty.
 */
export function sanitizeFilename(name: string | null | undefined): string {
  if (!name) return 'unnamed_file';
  // Strip directory components
  let sanitized = path.basename(name);
  // Keep only safe characters
  sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '');
  // Ensure non-empty
  if (!sanitized) return 'unnamed_file';
  // Limit length
  return sanitized.slice(0, 200);
}

/**
 * Format a Unix timestamp as YYYYMMDD_HHmmss.
 */
function formatDate(unixTs: number): string {
  const d = new Date(unixTs * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Process a Telegram message for media content.
 * Downloads the file and returns a ProcessedMedia object, or null if no media.
 */
/**
 * The attachment's identity, recorded on the raw durable record at receipt so
 * the record says WHAT is still owed, not merely that something is.
 */
export function mediaIdentity(msg: TelegramMessage): { media_type: string; file_id: string } | null {
  if (msg.photo && msg.photo.length > 0) return { media_type: 'photo', file_id: msg.photo[msg.photo.length - 1].file_id };
  if (msg.document) return { media_type: 'document', file_id: msg.document.file_id };
  if (msg.audio) return { media_type: 'audio', file_id: msg.audio.file_id };
  if (msg.voice) return { media_type: 'voice', file_id: msg.voice.file_id };
  if (msg.video) return { media_type: 'video', file_id: msg.video.file_id };
  if (msg.video_note) return { media_type: 'video_note', file_id: msg.video_note.file_id };
  return null;
}

export async function processMediaMessage(
  msg: TelegramMessage,
  api: TelegramAPI,
  downloadDir: string,
): Promise<ProcessedMedia | null> {
  const chatId = msg.chat.id;
  const from = msg.from?.first_name || 'Unknown';
  const date = msg.date || Math.floor(Date.now() / 1000);
  const caption = msg.caption || '';

  ensureDir(downloadDir);

  // Photo: get largest (last element in array)
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const fileResponse = await api.getFile(largest.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    // Extract unique suffix: last 11 chars of file_path before extension
    const baseName = path.basename(filePath);
    const nameWithoutExt = baseName.replace(/\.[^.]+$/, '');
    const suffix = nameWithoutExt.slice(-11);
    const dateStr = formatDate(date);
    const localFile = path.join(downloadDir, `${dateStr}_${suffix}.jpg`);

    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);

    return {
      type: 'photo',
      chat_id: chatId,
      from,
      text: caption,
      date,
      image_path: localFile,
    };
  }

  // Document
  if (msg.document) {
    const fileName = sanitizeFilename(msg.document.file_name);
    const fileResponse = await api.getFile(msg.document.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);

    return {
      type: 'document',
      chat_id: chatId,
      from,
      text: caption,
      date,
      file_path: localFile,
      file_name: fileName,
    };
  }

  // Audio
  if (msg.audio) {
    const defaultName = `audio_${date}.ogg`;
    const fileName = msg.audio.file_name
      ? sanitizeFilename(msg.audio.file_name)
      : defaultName;
    const fileResponse = await api.getFile(msg.audio.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);

    return {
      type: 'audio',
      chat_id: chatId,
      from,
      text: caption,
      date,
      file_path: localFile,
      file_name: fileName,
      duration: msg.audio.duration,
    };
  }

  // Voice
  if (msg.voice) {
    const fileName = `voice_${date}.ogg`;
    const fileResponse = await api.getFile(msg.voice.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);

    const transcript = await transcribeVoice(localFile);

    return {
      type: 'voice',
      chat_id: chatId,
      from,
      text: '',
      date,
      file_path: localFile,
      duration: msg.voice.duration,
      transcript: transcript || undefined,
    };
  }

  // Video
  if (msg.video) {
    const defaultName = `video_${date}.mp4`;
    const fileName = msg.video.file_name
      ? sanitizeFilename(msg.video.file_name)
      : defaultName;
    const fileResponse = await api.getFile(msg.video.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);

    return {
      type: 'video',
      chat_id: chatId,
      from,
      text: caption,
      date,
      file_path: localFile,
      file_name: fileName,
      duration: msg.video.duration,
    };
  }

  // Video Note (round video)
  if (msg.video_note) {
    const fileName = `videonote_${date}.mp4`;
    const fileResponse = await api.getFile(msg.video_note.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;

    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);

    return {
      type: 'video_note',
      chat_id: chatId,
      from,
      text: '',
      date,
      file_path: localFile,
      duration: msg.video_note.duration,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// A3 (2026-09-30): media identity + a download that lands at a fenced path.
// ---------------------------------------------------------------------------

export interface MediaReceipt {
  media_type: string;
  file_id: string;
  file_unique_id?: string;
  /** The sender's file name, when Telegram has one (documents, audio, video). */
  file_name?: string;
  duration?: number;
  /** telegram-images/<update_id>-<sanitized name>, relative to the agent dir. */
  media_dest: string;
}

/**
 * Everything the durable record needs at receipt to (re)download the
 * attachment later without the original update: its file_id, and a final path
 * that is unique per update (the update_id prefix) — two photos in the same
 * second, or two documents with the same name, can never overwrite each other.
 */
export function mediaReceipt(msg: TelegramMessage, updateId: number): MediaReceipt | null {
  const pick = (): { media_type: string; file_id: string; file_unique_id?: string; name: string; file_name?: string; duration?: number } | null => {
    if (msg.photo && msg.photo.length > 0) {
      const p = msg.photo[msg.photo.length - 1] as { file_id: string; file_unique_id?: string };
      return { media_type: 'photo', file_id: p.file_id, file_unique_id: p.file_unique_id, name: `photo-${sanitizeFilename(p.file_unique_id || 'image')}.jpg` };
    }
    if (msg.document) {
      const d = msg.document as { file_id: string; file_unique_id?: string; file_name?: string };
      return { media_type: 'document', file_id: d.file_id, file_unique_id: d.file_unique_id, name: sanitizeFilename(d.file_name), file_name: sanitizeFilename(d.file_name) };
    }
    if (msg.audio) {
      const a = msg.audio as { file_id: string; file_unique_id?: string; file_name?: string; duration?: number };
      const name = a.file_name ? sanitizeFilename(a.file_name) : 'audio.ogg';
      return { media_type: 'audio', file_id: a.file_id, file_unique_id: a.file_unique_id, name, file_name: name, duration: a.duration };
    }
    if (msg.voice) {
      const v = msg.voice as { file_id: string; file_unique_id?: string; duration?: number };
      return { media_type: 'voice', file_id: v.file_id, file_unique_id: v.file_unique_id, name: 'voice.ogg', duration: v.duration };
    }
    if (msg.video) {
      const v = msg.video as { file_id: string; file_unique_id?: string; file_name?: string; duration?: number };
      const name = v.file_name ? sanitizeFilename(v.file_name) : 'video.mp4';
      return { media_type: 'video', file_id: v.file_id, file_unique_id: v.file_unique_id, name, file_name: name, duration: v.duration };
    }
    if (msg.video_note) {
      const v = msg.video_note as { file_id: string; file_unique_id?: string; duration?: number };
      return { media_type: 'video_note', file_id: v.file_id, file_unique_id: v.file_unique_id, name: 'videonote.mp4', duration: v.duration };
    }
    return null;
  };
  const p = pick();
  if (!p) return null;
  const out: MediaReceipt = { media_type: p.media_type, file_id: p.file_id, media_dest: `telegram-images/${updateId}-${p.name}` };
  if (p.file_unique_id) out.file_unique_id = p.file_unique_id;
  if (p.file_name) out.file_name = p.file_name;
  if (p.duration !== undefined) out.duration = p.duration;
  return out;
}

/** `<dest>.part.<gen>` — the only place a download is written before its gen-fenced rename. */
export function partPathFor(destAbs: string, gen: number): string {
  return `${destAbs}.part.${gen}`;
}

/** Matches a part file and yields [update_id, gen]. */
export const PART_FILE_RE = /^(\d+)-.+\.part\.(\d+)$/;

/**
 * Download a Telegram file by file_id to `partPath`. Throws on any failure —
 * the caller (the daemon's media job) reports it to the checker. Never renames:
 * only a completion whose gen is still current may do that (A3).
 */
export async function downloadTelegramFileTo(api: TelegramAPI, fileId: string, partPath: string): Promise<void> {
  const fileResponse = await api.getFile(fileId);
  const filePath = fileResponse?.result?.file_path;
  if (!filePath) throw new Error(`getFile returned no file_path for ${fileId.slice(0, 12)}…`);
  const data = await api.downloadFile(filePath);
  ensureDir(path.dirname(partPath));
  fs.writeFileSync(partPath, data);
}
