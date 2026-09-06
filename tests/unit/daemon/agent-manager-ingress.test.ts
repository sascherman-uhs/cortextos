/**
 * OS-07 — agent-manager stands its own poller down when ingress owns the bot,
 * and does exactly what it always did when it does not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const started: string[] = [];
const stopped: string[] = [];

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    constructor(public name: string) {}
    async start() {}
    async stop() {}
    getStatus() { return { name: this.name, status: 'running' }; }
    onExit() {}
    onStatusChanged() {}
    setTelegramHandle() {}
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() { return Promise.resolve(); }
    stop() {}
    wake() {}
    static formatTelegramTextMessage() { return ''; }
    static readLastSent() { return null; }
  },
}));
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    async sendMessage() { return { ok: true }; }
    async getUpdates() { return { ok: true, result: [] }; }
  },
}));
vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    constructor() { started.push('poller'); }
    onMessage() {}
    onCallback() {}
    onReaction() {}
    lastExitReason = 'stopped-externally';
    async start() { return; }
    stop() { stopped.push('poller'); }
  },
}));
vi.mock('../../../src/bus/metrics.js', () => ({
  collectTelegramCommands: () => [],
  registerTelegramCommands: async () => ({ status: 'empty' as const, count: 0 }),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
const { resolveIngressPaths } = await import('../../../src/ingress/state.js');
const { enableMultiplexed } = await import('../../../src/ingress/cutover.js');

let framework: string;
let ctxRoot: string;

function writeAgent(name: string): string {
  const dir = join(framework, 'orgs', 'uhs', 'agents', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.env'),
    'BOT_TOKEN=111111111:ZZTEST-TOKEN-SENTINEL-aaaaaaaaaaaaaaaaaaaaa\nCHAT_ID=1001\nALLOWED_USER=4242\n',
  );
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ agent_name: name, enabled: true }));
  return dir;
}

beforeEach(() => {
  started.length = 0;
  stopped.length = 0;
  framework = mkdtempSync(join(tmpdir(), 'os07-am-fw-'));
  ctxRoot = mkdtempSync(join(tmpdir(), 'os07-am-ctx-'));
});
afterEach(() => {
  rmSync(framework, { recursive: true, force: true });
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('AgentManager × OS-07 ingress', () => {
  it('starts the per-agent poller when no bot is multiplexed (unchanged behaviour)', async () => {
    const dir = writeAgent('vera');
    const manager = new AgentManager('default', ctxRoot, framework, 'uhs');
    await manager.startAgent('vera', dir, undefined, 'uhs');
    expect(started).toContain('poller');
    await manager.stopAgent('vera');
  });

  it('does NOT start the per-agent poller once ingress owns the bot', async () => {
    const dir = writeAgent('vera');
    const paths = resolveIngressPaths({ ctxRoot, org: 'uhs' });
    await enableMultiplexed(paths, 'vera', {});

    const manager = new AgentManager('default', ctxRoot, framework, 'uhs');
    await manager.startAgent('vera', dir, undefined, 'uhs');
    expect(started).not.toContain('poller');
    // The agent itself is still running — this is a listener move, not an outage.
    expect(manager.getAgentNames()).toContain('vera');
    await manager.stopAgent('vera');
  });

  it('stops only the Telegram listener during a cutover, leaving the agent up', async () => {
    const dir = writeAgent('vera');
    const manager = new AgentManager('default', ctxRoot, framework, 'uhs');
    await manager.startAgent('vera', dir, undefined, 'uhs');
    expect(started).toContain('poller');

    const result = await manager.transferBotToIngress('vera', 'ZZTEST', 'ZZTEST-OS07');
    expect(result.ok).toBe(true);
    expect(stopped).toContain('poller');
    expect(manager.getAgentNames()).toContain('vera');
    await manager.stopAgent('vera');
  });
});
