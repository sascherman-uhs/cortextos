'use server';

import fs from 'fs';
import path from 'path';
import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/lib/types';

const PROTOCOL_PATH = path.join(
  process.env.JARVIS_ROOT ??
    path.join(
      process.env.HOME ?? '/Users/sascherman',
      'Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS',
    ),
  'vault/email-triage/action-protocol.md',
);

export async function fetchEmailTriageProtocol(): Promise<string> {
  try {
    return fs.readFileSync(PROTOCOL_PATH, 'utf-8');
  } catch {
    return '';
  }
}

export async function saveEmailTriageProtocol(
  content: string,
): Promise<ActionResult> {
  try {
    const dir = path.dirname(PROTOCOL_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROTOCOL_PATH, content, 'utf-8');
    revalidatePath('/settings');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
