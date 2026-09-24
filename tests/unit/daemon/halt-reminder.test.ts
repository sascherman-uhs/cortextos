import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// fleet-stability §A4.3 — the escape hatch.
//
// A durable halt fixes the spam but risks a silent permanent death, which would
// be a regression rather than a fix. So while an agent stays halted it must keep
// re-surfacing: ONE alert on the halt transition, then a RECURRING reminder.
// Three one-shot pings about trillion-coder were missed on 2026-09-24, which is
// why a single ping is not the design.

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: 'x', status: 'stopped' }; }
    onExit() { /* no-op */ }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class { constructor() { /* no-op */ } },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class { start() {} stop() {} },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
const { readHaltMarker, writeHaltMarker } = await import('../../../src/daemon/halt-marker.js');

const HOUR = 3600 * 1000;

interface Internals {
  telegramHandles: Map<string, { api: { sendMessage: (c: string, m: string) => Promise<void> }; chatId: string }>;
  haltReminder?: NodeJS.Timeout;
  sendHaltReminders(everyMs: number): void;
  startHaltReminder(): void;
}

let ctxRoot: string;
let sent: string[];

function makeManager() {
  const mgr = new AgentManager('test', ctxRoot, join(ctxRoot, 'fw'), 'uhs');
  const internals = mgr as unknown as Internals;
  internals.telegramHandles.set('trillion-coder', {
    api: { sendMessage: async (_chatId: string, msg: string) => { sent.push(msg); } },
    chatId: '8727328514',
  });
  return { mgr, internals };
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'ctx-halt-remind-'));
  sent = [];
  delete process.env['CTX_HALT_REMINDER_HOURS'];
  delete process.env['CTX_HALT_REMINDER_CHECK_MS'];
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  delete process.env['CTX_HALT_REMINDER_HOURS'];
  delete process.env['CTX_HALT_REMINDER_CHECK_MS'];
});

describe('recurring halt reminder', () => {
  it('re-alerts about an agent that is still halted, and records the alert', () => {
    writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'exceeded 10 crashes today' });
    const { internals } = makeManager();
    // Backdate the halt so the reminder interval has elapsed. A never-alerted
    // marker falls back to `since`, so this is the "halted five hours ago and
    // still nothing said" case.
    const marker = readHaltMarker(ctxRoot, 'trillion-coder')!;
    writeFileSync(
      join(ctxRoot, 'state', 'trillion-coder', '.halted'),
      JSON.stringify({ ...marker, since: new Date(Date.now() - 5 * HOUR).toISOString() }),
      'utf-8',
    );

    internals.sendHaltReminders(4 * HOUR);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('STILL HALTED');
    expect(sent[0]).toContain('cortextos unhalt trillion-coder');
    const after = readHaltMarker(ctxRoot, 'trillion-coder')!;
    expect(after.alertCount).toBe(1);
    expect(after.lastAlertAt).toBeTruthy();
  });

  it('does not re-alert before the interval has elapsed — and does again after it has', () => {
    writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'exceeded 10 crashes today' });
    const { internals } = makeManager();

    // Just halted: nothing yet.
    internals.sendHaltReminders(4 * HOUR);
    expect(sent).toHaveLength(0);

    // Backdate the last alert past the interval.
    const marker = readHaltMarker(ctxRoot, 'trillion-coder')!;
    writeFileSync(
      join(ctxRoot, 'state', 'trillion-coder', '.halted'),
      JSON.stringify({ ...marker, lastAlertAt: new Date(Date.now() - 5 * HOUR).toISOString(), alertCount: 1 }),
      'utf-8',
    );
    internals.sendHaltReminders(4 * HOUR);
    expect(sent).toHaveLength(1);
    expect(readHaltMarker(ctxRoot, 'trillion-coder')!.alertCount).toBe(2);

    // Immediately again: suppressed.
    internals.sendHaltReminders(4 * HOUR);
    expect(sent).toHaveLength(1);
  });

  it('stays quiet when nothing is halted', () => {
    const { internals } = makeManager();
    internals.sendHaltReminders(4 * HOUR);
    expect(sent).toHaveLength(0);
  });

  it('arms the interval once, and honours CTX_HALT_REMINDER_HOURS=0 as off', () => {
    const { internals } = makeManager();
    internals.startHaltReminder();
    const first = internals.haltReminder;
    expect(first).toBeTruthy();
    internals.startHaltReminder();
    expect(internals.haltReminder).toBe(first);
    clearInterval(first!);

    process.env['CTX_HALT_REMINDER_HOURS'] = '0';
    const { internals: off } = makeManager();
    off.startHaltReminder();
    expect(off.haltReminder).toBeUndefined();
  });
});
