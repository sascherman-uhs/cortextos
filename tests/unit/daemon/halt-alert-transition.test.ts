import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Adversarial verification of fleet-stability §A4.3/§A4.4 through the REAL
// AgentManager.startAgent() wiring rather than by poking internals:
//
//  - exactly ONE Telegram alert per halt TRANSITION, surviving a daemon restart
//    (three identical HALTED pings in ten minutes is the bug being fixed);
//  - the per-agent Telegram handle is registered even though the agent NEVER
//    STARTS, which is the case the recurring reminder depends on and the easiest
//    to get wrong — a halted agent has no live PTY of its own to alert from.

const sent: Array<{ chatId: string; msg: string }> = [];

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    async sendMessage(chatId: string, msg: string) { sent.push({ chatId, msg }); }
  },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  // Accept any handler registration — startAgent wires a dozen of them and the
  // set is not what this test is about.
  TelegramPoller: class {
    constructor() {
      return new Proxy(this, {
        get(target, prop) {
          if (prop === 'start') return async () => { /* no-op */ };
          return (target as Record<string | symbol, unknown>)[prop] ?? (() => { /* no-op */ });
        },
      });
    }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { async start() { /* no-op */ } stop() {} wake() {} },
}));

// AgentProcess stub that reproduces the real durable-halt gate: start() reads
// the marker and, when it exists, flips to 'halted' and notifies — exactly what
// src/daemon/agent-process.ts start() does.
vi.mock('../../../src/daemon/agent-process.js', async () => {
  const { readHaltMarker } = await import('../../../src/daemon/halt-marker.js');
  return {
    AgentProcess: class {
      name: string;
      private env: { ctxRoot: string };
      private status = 'stopped';
      private haltedSince: string | null = null;
      private cbs: Array<(s: unknown) => void> = [];
      constructor(name: string, env: { ctxRoot: string }) { this.name = name; this.env = env; }
      onStatusChanged(cb: (s: unknown) => void) { this.cbs.push(cb); }
      setTelegramHandle() { /* no-op */ }
      onExit() { /* no-op */ }
      async stop() { /* no-op */ }
      getStatus() {
        return { name: this.name, status: this.status, ...(this.haltedSince ? { haltedSince: this.haltedSince } : {}) };
      }
      async start() {
        const m = readHaltMarker(this.env.ctxRoot, this.name);
        if (m) {
          this.status = 'halted';
          this.haltedSince = m.since;
        } else {
          this.status = 'running';
        }
        for (const cb of this.cbs) cb(this.getStatus());
      }
    },
  };
});

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
const { writeHaltMarker, readHaltMarker } = await import('../../../src/daemon/halt-marker.js');

let testDir: string;
let ctxRoot: string;
let frameworkRoot: string;
let agentDir: string;

beforeEach(() => {
  sent.length = 0;
  testDir = mkdtempSync(join(tmpdir(), 'ctx-halt-alert-'));
  ctxRoot = join(testDir, 'instance');
  frameworkRoot = join(testDir, 'framework');
  agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'trillion-coder');
  mkdirSync(join(ctxRoot, 'config'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, '.env'),
    'BOT_TOKEN=123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nCHAT_ID=8727328514\nALLOWED_USER=8727328514\n',
    'utf-8',
  );
  writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ model: 'gpt-5-codex' }), 'utf-8');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function manager() {
  return new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
}

describe('halt alerting through the real startAgent wiring', () => {
  it('alerts ONCE per transition — a second daemon boot on the same halt is silent', async () => {
    writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'exceeded 10 crashes today', crashCount: 10, maxCrashes: 10 });

    // Boot 1.
    const a = manager();
    await a.startAgent('trillion-coder', agentDir, undefined, 'acme');
    await a.stopAll();
    expect(sent.map(s => s.msg)).toHaveLength(1);
    expect(sent[0].msg).toContain('HALTED');
    expect(sent[0].msg).toContain('cortextos unhalt trillion-coder');
    expect(readHaltMarker(ctxRoot, 'trillion-coder')!.alertCount).toBe(1);

    // Boot 2 and 3 on the SAME halt — the flapping case. Silence.
    for (const _ of [1, 2]) {
      const b = manager();
      await b.startAgent('trillion-coder', agentDir, undefined, 'acme');
      await b.stopAll();
    }
    expect(sent).toHaveLength(1);
    expect(readHaltMarker(ctxRoot, 'trillion-coder')!.alertCount).toBe(1);
  });

  it('registers the Telegram handle for an agent that NEVER started, so the reminder can still reach Scott', async () => {
    writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'exceeded 10 crashes today' });
    const a = manager();
    await a.startAgent('trillion-coder', agentDir, undefined, 'acme');

    const internals = a as unknown as {
      telegramHandles: Map<string, unknown>;
      sendHaltReminders(everyMs: number): void;
    };
    expect(internals.telegramHandles.has('trillion-coder')).toBe(true);

    // Backdate the alert past the reminder interval and sweep.
    const m = readHaltMarker(ctxRoot, 'trillion-coder')!;
    writeFileSync(
      join(ctxRoot, 'state', 'trillion-coder', '.halted'),
      JSON.stringify({ ...m, lastAlertAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString() }),
      'utf-8',
    );
    sent.length = 0;
    internals.sendHaltReminders(4 * 3600 * 1000);
    await a.stopAll();

    expect(sent).toHaveLength(1);
    expect(sent[0].msg).toContain('STILL HALTED');
    expect(sent[0].chatId).toBe('8727328514');
  });

  it('a genuine NEW transition after an unhalt alerts again', async () => {
    writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'exceeded 10 crashes today' });
    const a = manager();
    await a.startAgent('trillion-coder', agentDir, undefined, 'acme');
    await a.stopAll();
    expect(sent).toHaveLength(1);

    // Operator unhalts; the agent later exhausts its budget again.
    const { clearHaltMarker } = await import('../../../src/daemon/halt-marker.js');
    clearHaltMarker(ctxRoot, 'trillion-coder');
    writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'exceeded 10 crashes today' });

    const b = manager();
    await b.startAgent('trillion-coder', agentDir, undefined, 'acme');
    await b.stopAll();
    expect(sent).toHaveLength(2);
  });
});
