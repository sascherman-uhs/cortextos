/**
 * OS-07 — outbox exclusive-dispatch (2026-09-06 CortexOS V4 safety review, WP-4).
 *
 * Regression coverage for the live duplicate-send race: two concurrent
 * drains of the same pending entry must never both call `send`, and a
 * failure that cannot be proven pre-effect must never be silently retried.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveIngressPaths, type IngressPaths } from '../../../src/ingress/state.js';
import {
  enqueueReply,
  drainOutbox,
  readEntry,
  MAX_SEND_ATTEMPTS,
  type SendFn,
} from '../../../src/ingress/outbox.js';

let root: string;
let paths: IngressPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'os07-outbox-'));
  paths = resolveIngressPaths({ ctxRoot: root, org: 'uhs' });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function enqueue(dedupeKey: string, text = 'Moved to Thursday 8am.') {
  return enqueueReply(paths, {
    bot: 'vera',
    chat_id: '1001',
    text,
    dedupe_key: dedupeKey,
  });
}

describe('drainOutbox exclusive dispatch', () => {
  it('1. two concurrent drains of the same pending entry call send exactly once', async () => {
    enqueue('reply:concurrent-1');
    let sendCalls = 0;
    const send: SendFn = async (_bot, _chatId, _text, onNetworkStart) => {
      sendCalls += 1;
      onNetworkStart();
      // Hold the network call open so both drains are mid-flight together.
      await new Promise((r) => setTimeout(r, 20));
      return { status: 'sent', messageId: 1 };
    };

    const [a, b] = await Promise.all([drainOutbox(paths, send), drainOutbox(paths, send)]);

    expect(sendCalls).toBe(1);
    expect(a.sent + b.sent).toBe(1);
  });

  it('2. a write failure after a successful send leaves the entry ambiguous, not resent', async () => {
    const entry = enqueue('reply:crash-after-send');
    const send: SendFn = async (_bot, _chatId, _text, onNetworkStart) => {
      onNetworkStart();
      return { status: 'sent', messageId: 123 };
    };

    // Simulate "crash between send() resolving and markSent() persisting" by
    // injecting a persistSent that throws once, the same seam a real disk-
    // full or process-death failure would hit.
    await drainOutbox(paths, send, {}, 'test-worker', {
      persistSent: () => {
        throw new Error('simulated disk write failure right after provider confirmed send');
      },
    });

    const after = readEntry(paths, entry.id);
    expect(after?.status).toBe('ambiguous');

    // A later, normal drain must not touch it — ambiguous entries are
    // excluded from `listPending` and are never auto-resent.
    let sendCallsAfter = 0;
    await drainOutbox(paths, async (_b, _c, _t, onNetworkStart) => {
      sendCallsAfter += 1;
      onNetworkStart();
      return { status: 'sent', messageId: 999 };
    });
    expect(sendCallsAfter).toBe(0);
    expect(readEntry(paths, entry.id)?.status).toBe('ambiguous');
  });

  it('3. a send() that throws before any network I/O safely retries, bounded by MAX_SEND_ATTEMPTS', async () => {
    const entry = enqueue('reply:pre-send-throw');
    const send: SendFn = async () => {
      // Throws WITHOUT calling onNetworkStart — provably pre-effect.
      throw new Error('validation failed before any request was made');
    };

    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
      const before = readEntry(paths, entry.id)!;
      expect(before.status).toBe('pending');
      await drainOutbox(paths, send);
    }

    const after = readEntry(paths, entry.id);
    expect(after?.status).toBe('failed');
    expect(after?.attempts).toBe(MAX_SEND_ATTEMPTS);

    // Once failed, further drains do not touch it at all.
    let calls = 0;
    await drainOutbox(paths, async (_b, _c, _t, onNetworkStart) => {
      calls += 1;
      onNetworkStart();
      return { status: 'sent', messageId: 1 };
    });
    expect(calls).toBe(0);
  });

  it('4. a send() that throws AFTER network start goes to ambiguous, never retried', async () => {
    const entry = enqueue('reply:post-start-throw');
    const send: SendFn = async (_bot, _chatId, _text, onNetworkStart) => {
      onNetworkStart(); // provider may have already received the message
      throw new Error('socket hang up (disconnected mid-response)');
    };

    await drainOutbox(paths, send);
    const after = readEntry(paths, entry.id);
    expect(after?.status).toBe('ambiguous');
    expect(after?.attempts).toBe(0); // ambiguous is not a retry-counted failure

    let calls = 0;
    await drainOutbox(paths, async (_b, _c, _t, onNetworkStart) => {
      calls += 1;
      onNetworkStart();
      return { status: 'sent', messageId: 1 };
    });
    expect(calls).toBe(0);
    expect(readEntry(paths, entry.id)?.status).toBe('ambiguous');
  });

  it('5. restart (re-instantiate state from disk) preserves all record states', async () => {
    // Each phase enqueues and drains exactly one pending entry at a time, so
    // there is never cross-talk between the fake `send` behaviors below.
    const sentEntry = enqueue('reply:restart-sent', 't-sent');
    await drainOutbox(paths, async (_b, _c, _t, onNetworkStart) => {
      onNetworkStart();
      return { status: 'sent', messageId: 1 };
    });

    const failedEntry = enqueue('reply:restart-failed', 't-failed');
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
      await drainOutbox(paths, async () => {
        throw new Error('pre-send failure'); // never calls onNetworkStart
      });
    }

    const ambiguousEntry = enqueue('reply:restart-ambiguous', 't-ambiguous');
    await drainOutbox(paths, async (_b, _c, _t, onNetworkStart) => {
      onNetworkStart();
      throw new Error('ambiguous transport failure');
    });

    const pendingEntry = enqueue('reply:restart-pending', 't-pending');
    // Deliberately never drained — stays untouched pending.

    // Re-read fresh state as a "restart" would (new paths object, same disk).
    const restarted = resolveIngressPaths({ ctxRoot: root, org: 'uhs' });
    expect(readEntry(restarted, sentEntry.id)?.status).toBe('sent');
    expect(readEntry(restarted, failedEntry.id)?.status).toBe('failed');
    expect(readEntry(restarted, failedEntry.id)?.attempts).toBe(MAX_SEND_ATTEMPTS);
    expect(readEntry(restarted, ambiguousEntry.id)?.status).toBe('ambiguous');
    expect(readEntry(restarted, pendingEntry.id)?.status).toBe('pending');

    // A drain after "restart" only ever touches the genuinely pending one.
    const touched: string[] = [];
    await drainOutbox(restarted, async (_b, _c, text, onNetworkStart) => {
      touched.push(text);
      onNetworkStart();
      return { status: 'sent', messageId: 1 };
    });
    expect(touched).toEqual(['t-pending']);
  });
});
