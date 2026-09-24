/**
 * Slow-turn acknowledgment.
 *
 * Scott, 2026-09-24, after the transport and delivery-loss fixes shipped: "So,
 * is this fixed?" It was not, because the remaining gap was silence rather than
 * loss. At 02:51 that morning he sent three messages; all three were received
 * and injected correctly, and seventeen minutes later he had nothing back
 * because the agent was mid-turn doing real work. A busy agent and a dead one
 * look identical from a phone.
 *
 * The two properties that make this a fix rather than a new annoyance:
 *   1. An ordinary fast reply sends NO ack. He explicitly did not want a second
 *      notification on every request, so this is a delay, not a receipt.
 *   2. The ack is never recorded as a reply. `outbound-messages.jsonl` is the
 *      only evidence that `isAgentActive()` and reply_sla_audit.py accept for
 *      "answered"; booking the ack there would manufacture a clean delivery
 *      record for precisely the silences being fixed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { BusPaths } from '../../../src/types';

function createMockAgent(name = 'test-agent') {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(true),
    write: vi.fn(),
  } as any;
}

function createMockTelegramApi() {
  return {
    botId: '111222',
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function createTestPaths(testDir: string): BusPaths {
  const paths: any = {
    root: testDir,
    stateDir: join(testDir, 'state'),
    logDir: join(testDir, 'logs'),
    inboxDir: join(testDir, 'inbox'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
  for (const dir of Object.values(paths) as string[]) {
    if (dir !== testDir) mkdirSync(dir, { recursive: true });
  }
  return paths as BusPaths;
}

const CHAT = '999';

describe('FastChecker slow-turn ack', () => {
  let testDir: string;
  let paths: BusPaths;
  let api: ReturnType<typeof createMockTelegramApi>;
  let checker: any;

  /** Open an unanswered turn `ageMs` ago carrying `count` messages. */
  function openTurn(ageMs: number, count = 1) {
    checker.ackTurnStartedAt = Date.now() - ageMs;
    checker.ackTurnMessageCount = count;
    checker.ackSentForTurn = false;
  }

  beforeEach(() => {
    delete process.env.TELEGRAM_SLOW_ACK_MS;
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-slowack-test-'));
    paths = createTestPaths(testDir);
    api = createMockTelegramApi();
    checker = new FastChecker(createMockAgent(), paths, '/tmp/framework', {
      telegramApi: api,
      chatId: CHAT,
    }) as any;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.TELEGRAM_SLOW_ACK_MS;
  });

  it('stays SILENT on a turn younger than the delay — the fast-reply case', async () => {
    openTurn(5_000);
    await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('stays silent when no turn is open at all', async () => {
    await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('acknowledges once the turn has run past the delay', async () => {
    openTurn(60_000);
    await checker.maybeSendSlowTurnAck(api, CHAT);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [chat, text] = api.sendMessage.mock.calls[0];
    expect(chat).toBe(CHAT);
    expect(text).toMatch(/automatic receipt/i);
    expect(text).toMatch(/not an answer/i);
    expect(text).toContain('60s');
  });

  // 2026-09-24. The ack used to say "Still working" — which it cannot know, and
  // which was flatly false the morning Scott's 07:06 request sat unread until
  // 07:11 while the session finished unrelated work. A timer may report receipt
  // and elapsed time; it may not report progress.
  it('never claims progress it cannot observe', async () => {
    openTurn(60_000);
    await checker.maybeSendSlowTurnAck(api, CHAT);

    const text = api.sendMessage.mock.calls[0][1];
    expect(text).not.toMatch(/still working/i);
    expect(text).not.toMatch(/looking into|working on it|on it now/i);
  });

  it('says so explicitly when the message is queued behind other work', async () => {
    openTurn(60_000);
    checker.ackTurnQueuedBehindWork = true;
    await checker.maybeSendSlowTurnAck(api, CHAT);

    const text = api.sendMessage.mock.calls[0][1];
    expect(text).toMatch(/queued behind/i);
    expect(text).toMatch(/hasn't been read yet/i);
  });

  it('resetAckTurn clears the queued-behind-work flag, so it cannot leak into the next turn', async () => {
    openTurn(60_000);
    checker.ackTurnQueuedBehindWork = true;
    checker.resetAckTurn();
    expect(checker.ackTurnQueuedBehindWork).toBe(false);

    openTurn(60_000);
    await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(api.sendMessage.mock.calls[0][1]).not.toMatch(/queued behind/i);
  });

  it('sends ONE ack per turn, not one per poll cycle', async () => {
    openTurn(60_000);
    for (let i = 0; i < 25; i++) await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a burst gets one ack that names the count', async () => {
    openTurn(60_000, 3);
    await checker.maybeSendSlowTurnAck(api, CHAT);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][1]).toContain('all 3');
  });

  it('TELEGRAM_SLOW_ACK_MS=0 disables it entirely — the kill switch', async () => {
    process.env.TELEGRAM_SLOW_ACK_MS = '0';
    openTurn(10 * 60_000);
    await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('honours a custom delay', async () => {
    process.env.TELEGRAM_SLOW_ACK_MS = '120000';
    openTurn(60_000);
    await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(api.sendMessage).not.toHaveBeenCalled();

    openTurn(130_000);
    await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default on a garbage delay rather than acking instantly', async () => {
    process.env.TELEGRAM_SLOW_ACK_MS = 'soon';
    openTurn(5_000);
    await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('NEVER writes outbound-messages.jsonl — an ack is not an answer', async () => {
    openTurn(60_000);
    await checker.maybeSendSlowTurnAck(api, CHAT);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const outbound = join(paths.logDir, 'outbound-messages.jsonl');
    // If this file appears, isAgentActive() clears the turn, the durable
    // pending record is reaped and reply_sla_audit.py books an answer Scott
    // never got. The ack must be invisible to all three.
    expect(existsSync(outbound)).toBe(false);
  });

  it('a failed send is logged and left retryable, not swallowed as done', async () => {
    api.sendMessage.mockRejectedValueOnce(new Error('fetch failed'));
    openTurn(60_000);

    await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(checker.ackSentForTurn).toBe(false);

    await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(checker.ackSentForTurn).toBe(true);
  });

  it('resetAckTurn re-arms, so the NEXT slow turn is acked too', async () => {
    openTurn(60_000);
    await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    checker.resetAckTurn();
    expect(checker.ackTurnStartedAt).toBe(0);
    expect(checker.ackTurnMessageCount).toBe(0);

    openTurn(60_000);
    await checker.maybeSendSlowTurnAck(api, CHAT);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });
});
