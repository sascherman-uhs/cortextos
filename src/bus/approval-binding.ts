/**
 * OS-02 approval binding — what an approval button is actually allowed to authorize.
 *
 * Before this, a Telegram approval button carried `appr_allow_<approval_id>`:
 * the approval id in the clear, and nothing else. Every one of these follows
 * from that:
 *
 *  - An old button approves whatever the approval says NOW, not what it said
 *    when the button was posted. Edit the payload, and a click made yesterday
 *    authorizes today's different action.
 *  - A forwarded message carries a working button to whoever receives it.
 *  - A replayed callback re-decides an already-decided approval.
 *  - Nothing ties the click to the bot or chat it was posted in.
 *
 * A binding replaces the id with an opaque single-use reference to
 * `{approval_id, approval_version, payload_hash, action, bot_identity, chat_id,
 * allowed_decider, expires_at}`, stored in the approval authority. Verification
 * compares all of it and consumes the reference in the same locked step, so a
 * second click on the same button cannot decide twice.
 *
 * What a binding is NOT: authority to execute. Plan §4 is explicit that the
 * internal approval and the actual external action are separate events. A
 * consumed binding produces a decision; execution needs its own intent and the
 * provider's own receipt (see `recordExecutionIntent` / `recordExecutionReceipt`).
 */

import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Approval, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

export type ApprovalAction = 'allow' | 'deny';

export interface ApprovalBinding {
  /** Opaque, unguessable, single-use. This is what goes in `callback_data`. */
  ref: string;
  approval_id: string;
  approval_version: number;
  payload_hash: string;
  action: ApprovalAction;
  /** Which bot posted the button. A callback from another bot is not this one. */
  bot_identity: string;
  /** Which chat it was posted in. A forward lands in a different chat. */
  chat_id: string;
  /** Telegram user id (or 'dashboard'/'console' for first-party surfaces). */
  allowed_decider: string;
  expires_at: string;
  created_at: string;
  consumed_at?: string | null;
  consumed_by?: string | null;
}

export type BindingRejection =
  | 'unknown_ref'
  | 'already_consumed'
  | 'expired'
  | 'wrong_decider'
  | 'wrong_bot'
  | 'wrong_chat'
  | 'version_changed'
  | 'payload_changed'
  | 'approval_missing'
  | 'approval_resolved';

export interface BindingResult {
  ok: boolean;
  rejection?: BindingRejection;
  detail?: string;
  binding?: ApprovalBinding;
  /** The CURRENT approval, so the caller can re-render the real request rather
   *  than leaving the person staring at a stale button. */
  current?: Approval | null;
}

const DEFAULT_TTL_SEC = 60 * 60 * 24; // one day

function bindingDir(paths: BusPaths): string {
  return join(paths.approvalDir, 'bindings');
}

function bindingPath(paths: BusPaths, ref: string): string {
  return join(bindingDir(paths), `${ref}.json`);
}

/**
 * Stable, non-secret identity for a bot token.
 *
 * A Telegram token is `<bot_id>:<secret>`; the id half is public and is exactly
 * what distinguishes one bot from another. Taking only that half means a
 * binding file never contains a credential, so the approval store stays safe to
 * read, log and back up.
 */
export function botIdentityFor(token: string | undefined | null): string {
  const t = String(token ?? '');
  const id = t.split(':')[0];
  return /^\d+$/.test(id) ? id : 'unknown-bot';
}

/** Refs are filenames. Anything but hex could escape the directory. */
export function isValidRef(ref: string): boolean {
  return /^[a-f0-9]{32}$/.test(ref);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Stable hash of everything a decider is actually agreeing to.
 *
 * Deliberately excludes `updated_at` and the resolution fields: a timestamp
 * moving is not a change to the request, but a retitled or re-scoped request
 * is, and must invalidate a button already in someone's chat.
 */
export function payloadHash(approval: Pick<Approval, 'title' | 'category' | 'description' | 'requesting_agent' | 'org'>): string {
  const canonical = JSON.stringify({
    title: approval.title ?? '',
    category: approval.category ?? '',
    description: approval.description ?? '',
    requesting_agent: approval.requesting_agent ?? '',
    org: approval.org ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Version of an approval record. Legacy files have none; they read as 1. */
export function approvalVersion(approval: Approval & { version?: number }): number {
  return typeof approval.version === 'number' && approval.version > 0 ? approval.version : 1;
}

export function readApproval(paths: BusPaths, approvalId: string): Approval | null {
  for (const bucket of ['pending', 'resolved']) {
    const p = join(paths.approvalDir, bucket, `${approvalId}.json`);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf-8')) as Approval; } catch { return null; }
    }
  }
  return null;
}

/**
 * Mint one binding. Called once per button, so an Approve and a Deny button on
 * the same message are two independent single-use references — consuming one
 * does not silently arm or disarm the other beyond the approval itself moving.
 */
export function createBinding(
  paths: BusPaths,
  approval: Approval,
  action: ApprovalAction,
  opts: { botIdentity: string; chatId: string | number; allowedDecider: string | number; ttlSeconds?: number },
): ApprovalBinding {
  const binding: ApprovalBinding = {
    ref: randomBytes(16).toString('hex'),
    approval_id: approval.id,
    approval_version: approvalVersion(approval),
    payload_hash: payloadHash(approval),
    action,
    bot_identity: String(opts.botIdentity),
    chat_id: String(opts.chatId),
    allowed_decider: String(opts.allowedDecider),
    expires_at: new Date(Date.now() + (opts.ttlSeconds ?? DEFAULT_TTL_SEC) * 1000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z'),
    created_at: nowIso(),
    consumed_at: null,
    consumed_by: null,
  };
  ensureDir(bindingDir(paths));
  atomicWriteSync(bindingPath(paths, binding.ref), JSON.stringify(binding));
  return binding;
}

export function readBinding(paths: BusPaths, ref: string): ApprovalBinding | null {
  if (!isValidRef(ref)) return null;
  const p = bindingPath(paths, ref);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')) as ApprovalBinding; } catch { return null; }
}

/**
 * Verify and consume a binding in one step.
 *
 * Single-use is enforced with an O_EXCL marker file, so two simultaneous
 * clicks cannot both win: the loser gets `already_consumed`. That is the
 * duplicate-click case — one decision recorded, not two.
 *
 * Every check runs against the CURRENT approval, so a payload edited after the
 * button was posted invalidates it. A rejection always carries the current
 * approval so the caller can re-render the real request.
 */
export function consumeBinding(
  paths: BusPaths,
  ref: string,
  presented: { decider: string | number; botIdentity: string; chatId: string | number },
  now: () => number = Date.now,
): BindingResult {
  const binding = readBinding(paths, ref);
  if (!binding) return { ok: false, rejection: 'unknown_ref', detail: 'no such approval reference' };

  const current = readApproval(paths, binding.approval_id);

  if (binding.consumed_at) {
    return { ok: false, rejection: 'already_consumed', binding, current,
      detail: `already decided at ${binding.consumed_at}` };
  }
  if (new Date(binding.expires_at).getTime() <= now()) {
    return { ok: false, rejection: 'expired', binding, current,
      detail: `expired at ${binding.expires_at}` };
  }
  if (String(presented.decider) !== binding.allowed_decider) {
    return { ok: false, rejection: 'wrong_decider', binding, current,
      detail: 'this button was issued to a different person' };
  }
  if (String(presented.botIdentity) !== binding.bot_identity) {
    return { ok: false, rejection: 'wrong_bot', binding, current,
      detail: 'this button was issued on a different bot' };
  }
  if (String(presented.chatId) !== binding.chat_id) {
    return { ok: false, rejection: 'wrong_chat', binding, current,
      detail: 'this button was issued in a different chat — a forwarded button cannot authorize' };
  }
  if (!current) {
    return { ok: false, rejection: 'approval_missing', binding, current: null,
      detail: 'the approval this button refers to no longer exists' };
  }
  if (current.status !== 'pending') {
    return { ok: false, rejection: 'approval_resolved', binding, current,
      detail: `already ${current.status}` };
  }
  if (approvalVersion(current) !== binding.approval_version) {
    return { ok: false, rejection: 'version_changed', binding, current,
      detail: `request changed since this button was posted (v${binding.approval_version} -> v${approvalVersion(current)})` };
  }
  if (payloadHash(current) !== binding.payload_hash) {
    return { ok: false, rejection: 'payload_changed', binding, current,
      detail: 'the request text changed since this button was posted' };
  }

  // Single-use gate. O_EXCL: the first writer wins, the second is told the
  // decision is already made rather than making a second one.
  const marker = bindingPath(paths, ref) + '.consumed';
  try {
    writeFileSync(marker, `${presented.decider}\t${nowIso()}\n`, { flag: 'wx', encoding: 'utf-8', mode: 0o600 });
  } catch {
    return { ok: false, rejection: 'already_consumed', binding, current,
      detail: 'a simultaneous click already recorded this decision' };
  }

  binding.consumed_at = nowIso();
  binding.consumed_by = String(presented.decider);
  try {
    atomicWriteSync(bindingPath(paths, ref), JSON.stringify(binding));
  } catch (err) {
    try { unlinkSync(marker); } catch { /* best-effort */ }
    throw err;
  }

  return { ok: true, binding, current };
}

/** Retire every outstanding binding for an approval. Called when the approval
 *  is decided by any route, so a button posted elsewhere cannot decide it again. */
export function revokeBindingsFor(paths: BusPaths, approvalId: string, reason: string): number {
  const dir = bindingDir(paths);
  if (!existsSync(dir)) return 0;
  let revoked = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const p = join(dir, file);
    try {
      const b = JSON.parse(readFileSync(p, 'utf-8')) as ApprovalBinding;
      if (b.approval_id !== approvalId || b.consumed_at) continue;
      b.consumed_at = nowIso();
      b.consumed_by = `revoked:${reason}`;
      atomicWriteSync(p, JSON.stringify(b));
      revoked += 1;
    } catch { /* skip unreadable */ }
  }
  return revoked;
}

// ---------------------------------------------------------------------------
// Approval event journal + the separate execution receipt
// ---------------------------------------------------------------------------

export interface ApprovalEvent {
  ts: string;
  approval_id: string;
  event: string;
  actor: string;
  route?: string;
  payload?: Record<string, unknown>;
}

export function appendApprovalEvent(paths: BusPaths, entry: Omit<ApprovalEvent, 'ts'>): void {
  const dir = join(paths.approvalDir, 'events');
  ensureDir(dir);
  const { appendFileSync } = require('fs') as typeof import('fs');
  appendFileSync(
    join(dir, `${entry.approval_id}.jsonl`),
    JSON.stringify({ ts: nowIso(), ...entry }) + '\n',
    { encoding: 'utf-8', mode: 0o600 },
  );
}

export function readApprovalEvents(paths: BusPaths, approvalId: string): ApprovalEvent[] {
  const p = join(paths.approvalDir, 'events', `${approvalId}.jsonl`);
  if (!existsSync(p)) return [];
  const out: ApprovalEvent[] = [];
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as ApprovalEvent); } catch { /* skip corrupt */ }
  }
  return out;
}

export interface ExecutionReceipt {
  approval_id: string;
  intent_id: string;
  /** intent -> execution -> verified. Ambiguous outcomes stop at `executed`
   *  and are reconciled, never blindly repeated (plan §4 idempotency). */
  stage: 'intent' | 'executed' | 'verified' | 'ambiguous';
  action: string;
  target: string;
  provider_receipt?: unknown;
  at: string;
}

function receiptPath(paths: BusPaths, approvalId: string, intentId: string): string {
  return join(paths.approvalDir, 'receipts', `${approvalId}.${intentId}.json`);
}

/**
 * Record the INTENT to execute. Separate from the approval decision on purpose:
 * an approval readback must precede a distinct execution intent, so a decision
 * that was recorded but never acted on is visibly different from one that was.
 */
export function recordExecutionIntent(
  paths: BusPaths,
  approvalId: string,
  intentId: string,
  action: string,
  target: string,
): ExecutionReceipt {
  const receipt: ExecutionReceipt = {
    approval_id: approvalId, intent_id: intentId, stage: 'intent', action, target, at: nowIso(),
  };
  ensureDir(join(paths.approvalDir, 'receipts'));
  atomicWriteSync(receiptPath(paths, approvalId, intentId), JSON.stringify(receipt));
  appendApprovalEvent(paths, { approval_id: approvalId, event: 'execution:intent', actor: 'system',
    payload: { intent_id: intentId, action, target } });
  return receipt;
}

/** Advance a receipt with what the provider actually said. An `ambiguous`
 *  outcome is a first-class stage: it means reconcile, not retry. */
export function recordExecutionReceipt(
  paths: BusPaths,
  approvalId: string,
  intentId: string,
  stage: 'executed' | 'verified' | 'ambiguous',
  providerReceipt: unknown,
): ExecutionReceipt {
  const p = receiptPath(paths, approvalId, intentId);
  if (!existsSync(p)) throw new Error(`No execution intent ${intentId} for approval ${approvalId}`);
  const receipt = JSON.parse(readFileSync(p, 'utf-8')) as ExecutionReceipt;
  receipt.stage = stage;
  receipt.provider_receipt = providerReceipt;
  receipt.at = nowIso();
  atomicWriteSync(p, JSON.stringify(receipt));
  appendApprovalEvent(paths, { approval_id: approvalId, event: `execution:${stage}`, actor: 'system',
    payload: { intent_id: intentId } });
  return receipt;
}

/** True when this intent has already been executed. The idempotency check a
 *  retry must make before repeating an external effect. */
export function alreadyExecuted(paths: BusPaths, approvalId: string, intentId: string): boolean {
  const p = receiptPath(paths, approvalId, intentId);
  if (!existsSync(p)) return false;
  try {
    const r = JSON.parse(readFileSync(p, 'utf-8')) as ExecutionReceipt;
    return r.stage === 'executed' || r.stage === 'verified' || r.stage === 'ambiguous';
  } catch {
    return false;
  }
}
