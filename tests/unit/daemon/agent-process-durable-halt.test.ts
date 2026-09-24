import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// fleet-stability §A4 — durable halt.
//
// These run against a REAL temp ctxRoot, not a mocked fs: the bug being fixed is
// precisely that the halt lived in process memory (`crashCount`/`status` are
// instance fields, and `new AgentProcess()` runs on every startAgent() call), so
// a test that mocked the filesystem away would not distinguish the fix from the
// bug. trillion-coder, 2026-09-24:
//   [11:05:20Z] HALTED: exit_code=0 crash_count=10 max_crashes=10
//   [11:07:21Z] HALTED: exit_code=0 crash_count=11 max_crashes=10
//   [11:15:01Z] HALTED: exit_code=0 crash_count=12 max_crashes=10

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(4242),
  isAlive: vi.fn().mockReturnValue(true),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: () => true }),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
const { haltMarkerPath, readHaltMarker, writeHaltMarker, clearHaltMarker } =
  await import('../../../src/daemon/halt-marker.js');

let ctxRoot: string;
let logs: string[];

function makeAgent(config: Record<string, unknown> = {}) {
  const env = {
    instanceId: 'test',
    ctxRoot,
    frameworkRoot: join(ctxRoot, 'fw'),
    agentName: 'trillion-coder',
    agentDir: join(ctxRoot, 'fw', 'orgs', 'uhs', 'agents', 'trillion-coder'),
    org: 'uhs',
    projectRoot: join(ctxRoot, 'fw'),
  } as never;
  return new AgentProcess('trillion-coder', env, config as never, (m) => logs.push(m));
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'ctx-agent-halt-'));
  logs = [];
  capturedOnExit = null;
  mockPty.spawn.mockClear();
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('start() refuses to spawn past a persisted halt', () => {
  it('spawns normally when there is no marker', async () => {
    const agent = makeAgent();
    await agent.start();
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);
    expect(agent.getStatus().status).toBe('running');
  });

  it('refuses to spawn when a marker exists, and reports halted', async () => {
    writeHaltMarker(ctxRoot, 'trillion-coder', {
      reason: 'exceeded 10 crashes today',
      crashCount: 10,
      maxCrashes: 10,
    });
    const agent = makeAgent();
    await agent.start();
    expect(mockPty.spawn).not.toHaveBeenCalled();
    const status = agent.getStatus();
    expect(status.status).toBe('halted');
    expect(status.haltedSince).toBeTruthy();
    expect(logs.join('\n')).toContain('cortextos unhalt trillion-coder');
  });

  it('survives a brand-new AgentProcess — the regression that let daemon boot and `cortextos restart` resurrect a halted agent', async () => {
    writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'exceeded 10 crashes today' });

    // Simulate startAgent()'s `new AgentProcess(...)`, three times over —
    // the shape of the three HALTED lines in ten minutes. crashCount/status
    // start clean on each instance; the marker does not.
    for (let i = 0; i < 3; i++) {
      const fresh = makeAgent();
      expect(fresh.getStatus().crashCount).toBe(0); // instance state IS reset
      await fresh.start();
      expect(fresh.getStatus().status).toBe('halted');
    }
    expect(mockPty.spawn).not.toHaveBeenCalled();
  });

  it('sessionRefresh() cannot bypass the gate either', async () => {
    writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'exceeded 10 crashes today' });
    const agent = makeAgent();
    await agent.sessionRefresh();
    expect(mockPty.spawn).not.toHaveBeenCalled();
    expect(agent.getStatus().status).toBe('halted');
  });

  it('spawns again once an operator clears the marker', async () => {
    writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'exceeded 10 crashes today' });
    const blocked = makeAgent();
    await blocked.start();
    expect(mockPty.spawn).not.toHaveBeenCalled();

    expect(clearHaltMarker(ctxRoot, 'trillion-coder')).toBe(true);
    expect(existsSync(haltMarkerPath(ctxRoot, 'trillion-coder'))).toBe(false);

    const allowed = makeAgent();
    await allowed.start();
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);
    expect(allowed.getStatus().status).toBe('running');
  });
});

describe('a crash-budget halt writes the marker', () => {
  it('halts durably on the last crash of the daily budget', async () => {
    // Pre-seed the persisted daily crash counter one short of the cap so a
    // single crash tips it over.
    const today = new Date().toISOString().split('T')[0];
    mkdirSync(join(ctxRoot, 'logs', 'trillion-coder'), { recursive: true });
    writeFileSync(join(ctxRoot, 'logs', 'trillion-coder', '.crash_count_today'), `${today}:9`, 'utf-8');

    const agent = makeAgent({ max_crashes_per_day: 10 });
    await agent.start();
    expect(capturedOnExit).toBeTruthy();
    capturedOnExit!(0, undefined);

    const marker = readHaltMarker(ctxRoot, 'trillion-coder');
    expect(marker).not.toBeNull();
    expect(marker!.reason).toContain('10 crashes');
    expect(marker!.crashCount).toBe(10);
    expect(agent.getStatus().status).toBe('halted');

    // And the restarts.log line the operator sees keeps its old shape.
    const restarts = readFileSync(join(ctxRoot, 'logs', 'trillion-coder', 'restarts.log'), 'utf-8');
    expect(restarts).toContain('HALTED: exit_code=0 crash_count=10 max_crashes=10');
  });

  it('does not double-count the daily crash counter across a daemon restart', async () => {
    const today = new Date().toISOString().split('T')[0];
    mkdirSync(join(ctxRoot, 'logs', 'trillion-coder'), { recursive: true });
    writeFileSync(join(ctxRoot, 'logs', 'trillion-coder', '.crash_count_today'), `${today}:5`, 'utf-8');

    // A fresh instance (crashCount = 0 in memory, 5 on disk) crashing once must
    // land on 6, not 7 — the file is authoritative, so the in-memory
    // pre-increment must not be counted twice.
    const agent = makeAgent({ max_crashes_per_day: 10 });
    await agent.start();
    capturedOnExit!(0, undefined);
    expect(agent.getStatus().crashCount).toBe(6);
    expect(readFileSync(join(ctxRoot, 'logs', 'trillion-coder', '.crash_count_today'), 'utf-8'))
      .toBe(`${today}:6`);
  });

  it('starts today from 1 when the persisted counter is from an earlier day', async () => {
    mkdirSync(join(ctxRoot, 'logs', 'trillion-coder'), { recursive: true });
    writeFileSync(join(ctxRoot, 'logs', 'trillion-coder', '.crash_count_today'), '2026-01-01:9', 'utf-8');
    const agent = makeAgent({ max_crashes_per_day: 10 });
    await agent.start();
    capturedOnExit!(0, undefined);
    expect(agent.getStatus().crashCount).toBe(1);
    expect(readHaltMarker(ctxRoot, 'trillion-coder')).toBeNull();
  });
});
