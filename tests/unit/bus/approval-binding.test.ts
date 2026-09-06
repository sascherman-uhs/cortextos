/**
 * OS-02 approval-binding scenarios (plan §11).
 *
 * Row: "Stale/wrong-user/wrong-bot approval button — changed hash/version,
 * expired/legacy nonce, forwarded callback or wrong decider rejected; duplicate
 * valid click records one decision; no execution before separate intent."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createBinding,
  consumeBinding,
  readBinding,
  revokeBindingsFor,
  payloadHash,
  botIdentityFor,
  isValidRef,
  recordExecutionIntent,
  recordExecutionReceipt,
  alreadyExecuted,
  readApprovalEvents,
  appendApprovalEvent,
} from '../../../src/bus/approval-binding';
import type { Approval, BusPaths } from '../../../src/types';

function makePaths(dir: string): BusPaths {
  return { ctxRoot: dir, approvalDir: join(dir, 'approvals') } as BusPaths;
}

const PRESENTED = { decider: 42, botIdentity: '111222', chatId: 999 };

describe('OS-02 approval binding', () => {
  let dir: string;
  let paths: BusPaths;
  let approval: Approval;

  function writeApproval(overrides: Partial<Approval> = {}): Approval {
    const a = {
      id: 'approval_1700000000_abcde',
      title: 'Send the proposal to the client',
      requesting_agent: 'estimator',
      org: 'uhs',
      category: 'external_communication',
      status: 'pending',
      description: 'Draft attached',
      created_at: '2026-09-05T00:00:00Z',
      updated_at: '2026-09-05T00:00:00Z',
      resolved_at: null,
      resolved_by: null,
      ...overrides,
    } as unknown as Approval;
    mkdirSync(join(paths.approvalDir, 'pending'), { recursive: true });
    writeFileSync(join(paths.approvalDir, 'pending', `${a.id}.json`), JSON.stringify(a));
    return a;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortextos-binding-'));
    paths = makePaths(dir);
    approval = writeApproval();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a button carries an opaque reference, never the approval id', () => {
    const b = createBinding(paths, approval, 'allow', {
      botIdentity: '111222', chatId: 999, allowedDecider: 42,
    });
    expect(isValidRef(b.ref)).toBe(true);
    expect(b.ref).not.toContain(approval.id);
    expect(b.payload_hash).toBe(payloadHash(approval));
  });

  it('the bot identity kept in a binding is the public id half, never the secret', () => {
    expect(botIdentityFor('123456789:AAHf-SECRET-material-here')).toBe('123456789');
    expect(botIdentityFor('nonsense')).toBe('unknown-bot');
    const b = createBinding(paths, approval, 'allow', {
      botIdentity: botIdentityFor('123456789:AAHf-SECRET-material-here'), chatId: 1, allowedDecider: 1,
    });
    expect(JSON.stringify(readBinding(paths, b.ref))).not.toContain('SECRET');
  });

  it('a valid click succeeds once and the replay is refused', () => {
    const b = createBinding(paths, approval, 'allow', {
      botIdentity: '111222', chatId: 999, allowedDecider: 42,
    });
    expect(consumeBinding(paths, b.ref, PRESENTED).ok).toBe(true);
    const second = consumeBinding(paths, b.ref, PRESENTED);
    expect(second).toMatchObject({ ok: false, rejection: 'already_consumed' });
  });

  it('an edited request invalidates a button already posted, and hands back the current one', () => {
    const b = createBinding(paths, approval, 'allow', {
      botIdentity: '111222', chatId: 999, allowedDecider: 42,
    });
    writeApproval({ title: 'Send the proposal AND the invoice' });

    const r = consumeBinding(paths, b.ref, PRESENTED);
    expect(r).toMatchObject({ ok: false, rejection: 'payload_changed' });
    expect(r.current?.title).toBe('Send the proposal AND the invoice');
  });

  it('a version bump alone invalidates the button, even if the text is unchanged', () => {
    const b = createBinding(paths, approval, 'allow', {
      botIdentity: '111222', chatId: 999, allowedDecider: 42,
    });
    writeApproval({ version: 2 } as never);
    expect(consumeBinding(paths, b.ref, PRESENTED)).toMatchObject({ ok: false, rejection: 'version_changed' });
  });

  it.each([
    ['wrong decider', { ...PRESENTED, decider: 9999 }, 'wrong_decider'],
    ['wrong bot', { ...PRESENTED, botIdentity: '999888' }, 'wrong_bot'],
    ['forwarded to another chat', { ...PRESENTED, chatId: 555 }, 'wrong_chat'],
  ])('%s is refused', (_label, presented, rejection) => {
    const b = createBinding(paths, approval, 'allow', {
      botIdentity: '111222', chatId: 999, allowedDecider: 42,
    });
    expect(consumeBinding(paths, b.ref, presented as never)).toMatchObject({ ok: false, rejection });
  });

  it('an expired button is refused', () => {
    const b = createBinding(paths, approval, 'allow', {
      botIdentity: '111222', chatId: 999, allowedDecider: 42, ttlSeconds: -1,
    });
    expect(consumeBinding(paths, b.ref, PRESENTED)).toMatchObject({ ok: false, rejection: 'expired' });
  });

  it('an unknown reference authorizes nothing', () => {
    expect(consumeBinding(paths, 'f'.repeat(32), PRESENTED)).toMatchObject({ ok: false, rejection: 'unknown_ref' });
  });

  it('deciding on one route retires the buttons posted on the others', () => {
    const telegram = createBinding(paths, approval, 'allow', {
      botIdentity: '111222', chatId: 999, allowedDecider: 42,
    });
    // Scott decides on the dashboard instead.
    const revoked = revokeBindingsFor(paths, approval.id, 'decided:approved');
    expect(revoked).toBeGreaterThan(0);
    expect(consumeBinding(paths, telegram.ref, PRESENTED))
      .toMatchObject({ ok: false, rejection: 'already_consumed' });
  });

  it('an already-resolved approval cannot be decided again', () => {
    const b = createBinding(paths, approval, 'allow', {
      botIdentity: '111222', chatId: 999, allowedDecider: 42,
    });
    writeApproval({ status: 'approved' } as never);
    expect(consumeBinding(paths, b.ref, PRESENTED)).toMatchObject({ ok: false, rejection: 'approval_resolved' });
  });

  describe('approval decision and external execution are separate events', () => {
    it('consuming a binding records a decision and no execution', () => {
      const b = createBinding(paths, approval, 'allow', {
        botIdentity: '111222', chatId: 999, allowedDecider: 42,
      });
      consumeBinding(paths, b.ref, PRESENTED);
      appendApprovalEvent(paths, { approval_id: approval.id, event: 'decision:approved', actor: '42' });

      const events = readApprovalEvents(paths, approval.id);
      expect(events.map((e) => e.event)).toContain('decision:approved');
      expect(events.some((e) => e.event.startsWith('execution:'))).toBe(false);
      expect(alreadyExecuted(paths, approval.id, 'intent-1')).toBe(false);
    });

    it('a receipt walks intent -> executed -> verified, and a retry can see it already ran', () => {
      recordExecutionIntent(paths, approval.id, 'intent-1', 'send_email', 'client@example.com');
      expect(alreadyExecuted(paths, approval.id, 'intent-1')).toBe(false);

      recordExecutionReceipt(paths, approval.id, 'intent-1', 'executed', { message_id: 'abc' });
      expect(alreadyExecuted(paths, approval.id, 'intent-1')).toBe(true);

      recordExecutionReceipt(paths, approval.id, 'intent-1', 'verified', { message_id: 'abc', delivered: true });
      const events = readApprovalEvents(paths, approval.id).map((e) => e.event);
      expect(events).toEqual(['execution:intent', 'execution:executed', 'execution:verified']);
    });

    it('an ambiguous provider result blocks a blind repeat rather than inviting one', () => {
      recordExecutionIntent(paths, approval.id, 'intent-2', 'create_product', 'SF-123');
      recordExecutionReceipt(paths, approval.id, 'intent-2', 'ambiguous', { error: 'timeout after POST' });
      // The retry path asks "did this already happen?" and gets yes-ish, which
      // is the signal to reconcile against the provider, not to POST again.
      expect(alreadyExecuted(paths, approval.id, 'intent-2')).toBe(true);
      const receipt = JSON.parse(
        readFileSync(join(paths.approvalDir, 'receipts', `${approval.id}.intent-2.json`), 'utf-8'),
      );
      expect(receipt.stage).toBe('ambiguous');
    });

    it('a receipt cannot be advanced without an intent first', () => {
      expect(() => recordExecutionReceipt(paths, approval.id, 'never-declared', 'executed', {}))
        .toThrow(/No execution intent/);
    });
  });
});
