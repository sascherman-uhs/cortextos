/**
 * DEFECT 6 — an unpin/switch that restarts an agent marked itself `blocked`
 * with `start failed: start request for "jarvis-mls" deduped — agent already
 * in registry`, even though the agent DID restart (new PID, fresh attempt).
 *
 * `inspectAgentOp('start')` answers DEDUPED whenever the agent is still in the
 * daemon's in-memory registry when the start lands, which is exactly the
 * stop+start pair the model switch issues. The restarter took that string as a
 * verdict instead of reading the agent back.
 *
 * These tests drive the REAL restarter against a fake IPC client, so they
 * cover the stop → start → confirm sequencing rather than just the classifier.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface FakeStatusRow { name: string; pid?: number; sessionStart?: string; status?: string }
interface FakeResponse { success: boolean; data?: unknown; error?: string; code?: string }

/** Scripted daemon: each `send` is answered from the queue for its type. */
const script = {
  daemonRunning: true,
  statuses: [] as FakeStatusRow[][],
  stop: { success: true } as FakeResponse,
  start: { success: true } as FakeResponse,
  sent: [] as string[],
};

vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    async isDaemonRunning(): Promise<boolean> {
      return script.daemonRunning;
    }
    async send(req: { type: string }): Promise<FakeResponse> {
      script.sent.push(req.type);
      if (req.type === 'status') {
        // Replay the scripted timeline, holding on the last frame.
        const next = script.statuses.length > 1 ? script.statuses.shift()! : script.statuses[0] ?? [];
        return { success: true, data: next };
      }
      if (req.type === 'stop-agent') return script.stop;
      if (req.type === 'start-agent') return script.start;
      return { success: false, error: `unexpected ${req.type}` };
    }
  },
}));

const DEDUPE_ERROR =
  'start request for "jarvis-mls" deduped — agent already in registry (in-flight start or already running)';

let root: string;

async function loadRegistryModule(): Promise<typeof import('../../../src/bus/model-registry.js')> {
  return import('../../../src/bus/model-registry.js');
}

function seedRegistry(): void {
  const orgDir = join(root, 'orgs', 'uhs');
  mkdirSync(orgDir, { recursive: true });
  writeFileSync(
    join(orgDir, 'model-registry.json'),
    JSON.stringify({
      schema_version: 1,
      revision: 1,
      updated_at: '2026-09-05T00:00:00Z',
      updated_by: 'test',
      activation: { org_default: 'shadow', consumers: {} },
      adapters: { 'claude-code': { version: 1, selection: 'cli:--model', observed_source: 'claude-transcript', supports: [], auth_source: null } },
      entries: {
        'anthropic-haiku': {
          model_id: 'claude-haiku-4-5-20251001', provider: 'anthropic', runtime_adapter: 'claude-code',
          capability_tags: ['tool-use'], context_window: 200000, billing_mode: 'subscription_quota',
          cost_class: 1, auth_source: null, status: 'active',
        },
      },
      tiers: { economy: ['anthropic-haiku'] },
      org_default_tier: 'economy',
      roles: { listing_intel: { tier: 'economy', required_capabilities: [], min_context: 1000, data_scope: 'org' } },
      agents: { 'jarvis-mls': { role: 'listing_intel', pin: null } },
      callsites: {},
    }, null, 2),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctx-restart-dedup-'));
  seedRegistry();
  script.daemonRunning = true;
  script.statuses = [];
  script.stop = { success: true };
  script.start = { success: true };
  script.sent = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

const ctx = (): { root: string; org: string; frameworkRoot: string; ctxRoot: string } => ({
  root, org: 'uhs', frameworkRoot: root, ctxRoot: root,
});

describe('createDaemonRestarter', () => {
  it('treats a deduped start as success once a fresh PID appears', async () => {
    const { createDaemonRestarter } = await loadRegistryModule();
    script.start = { success: false, code: 'DEDUPED', error: DEDUPE_ERROR };
    script.statuses = [
      [{ name: 'jarvis-mls', pid: 811, sessionStart: '2026-09-05T11:00:00Z', status: 'running' }],
      [{ name: 'jarvis-mls', pid: 902, sessionStart: '2026-09-05T12:00:01Z', status: 'running' }],
    ];

    const result = await createDaemonRestarter(ctx(), 2000)('jarvis-mls');

    expect(result.ok).toBe(true);
    expect(result.deduped_but_restarted).toBe(true);
    expect(result.pid_before).toBe(811);
    expect(result.pid).toBe(902);
    expect(result.session_start).toBe('2026-09-05T12:00:01Z');
    expect(result.detail).toMatch(/deduped/);
    expect(script.sent).toContain('stop-agent');
    expect(script.sent).toContain('start-agent');
  });

  it('accepts a deduped start confirmed only by a changed session start', async () => {
    const { createDaemonRestarter } = await loadRegistryModule();
    script.start = { success: false, error: DEDUPE_ERROR };
    script.statuses = [
      [{ name: 'jarvis-mls', pid: 811, sessionStart: '2026-09-05T11:00:00Z', status: 'running' }],
      [{ name: 'jarvis-mls', pid: 811, sessionStart: '2026-09-05T12:30:00Z', status: 'running' }],
    ];
    const result = await createDaemonRestarter(ctx(), 2000)('jarvis-mls');
    expect(result.ok).toBe(true);
    expect(result.session_start).toBe('2026-09-05T12:30:00Z');
  });

  it('fails a deduped start when the agent never came back', async () => {
    const { createDaemonRestarter } = await loadRegistryModule();
    script.start = { success: false, code: 'DEDUPED', error: DEDUPE_ERROR };
    script.statuses = [
      [{ name: 'jarvis-mls', pid: 811, sessionStart: '2026-09-05T11:00:00Z', status: 'running' }],
    ];
    const result = await createDaemonRestarter(ctx(), 600)('jarvis-mls');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no fresh session appeared/);
    expect(result.pid_before).toBe(811);
  });

  it('reads the new PID back even on a plain successful start', async () => {
    const { createDaemonRestarter } = await loadRegistryModule();
    script.statuses = [
      [{ name: 'jarvis-mls', pid: 811, sessionStart: '2026-09-05T11:00:00Z', status: 'running' }],
      [{ name: 'jarvis-mls', pid: 950, sessionStart: '2026-09-05T12:00:05Z', status: 'running' }],
    ];
    const result = await createDaemonRestarter(ctx(), 2000)('jarvis-mls');
    expect(result.ok).toBe(true);
    expect(result.deduped_but_restarted).toBeUndefined();
    expect(result.pid).toBe(950);
  });

  it('does not claim success on an acknowledged start that produced nothing', async () => {
    const { createDaemonRestarter } = await loadRegistryModule();
    script.statuses = [
      [{ name: 'jarvis-mls', pid: 811, sessionStart: '2026-09-05T11:00:00Z', status: 'running' }],
    ];
    const result = await createDaemonRestarter(ctx(), 600)('jarvis-mls');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no fresh session appeared/);
  });

  it('reports a genuine start failure as a failure, not a dedupe', async () => {
    const { createDaemonRestarter } = await loadRegistryModule();
    script.start = { success: false, error: 'Agent directory not found for jarvis-mls' };
    script.statuses = [[{ name: 'jarvis-mls', pid: 811, status: 'running' }]];
    const result = await createDaemonRestarter(ctx(), 600)('jarvis-mls');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Agent directory not found/);
  });

  it('reports a stop failure without attempting a start', async () => {
    const { createDaemonRestarter } = await loadRegistryModule();
    script.stop = { success: false, error: 'agent "jarvis-mls" not in registry — cannot stop' };
    script.statuses = [[{ name: 'jarvis-mls', pid: 811, status: 'running' }]];
    const result = await createDaemonRestarter(ctx(), 600)('jarvis-mls');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/stop failed/);
    expect(script.sent).not.toContain('start-agent');
  });

  it('says the daemon is down rather than guessing', async () => {
    const { createDaemonRestarter } = await loadRegistryModule();
    script.daemonRunning = false;
    const result = await createDaemonRestarter(ctx(), 600)('jarvis-mls');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/daemon not running/);
  });
});

describe('applyOperation through the real restarter', () => {
  it('applies (not blocks) a switch whose start came back deduped', async () => {
    const { applyOperation } = await loadRegistryModule();
    script.start = { success: false, code: 'DEDUPED', error: DEDUPE_ERROR };
    script.statuses = [
      [{ name: 'jarvis-mls', pid: 811, sessionStart: '2026-09-05T11:00:00Z', status: 'running' }],
      [{ name: 'jarvis-mls', pid: 902, sessionStart: '2026-09-05T12:00:01Z', status: 'running' }],
    ];

    const receipt = await applyOperation(
      { kind: 'switch', role: 'listing_intel', tier: 'economy', actor: 'scott', reason: 'defect 6' },
      { ...ctx(), restartConfirmMs: 2000 },
    );

    expect(receipt.state).toBe('applied');
    expect(receipt.error).toBeNull();
    expect(receipt.restart_required).toBe(true);
    expect(receipt.restart_results[0].pid).toBe(902);
    expect(receipt.restart_results[0].deduped_but_restarted).toBe(true);
  });

  it('still blocks when the deduped start produced no new session', async () => {
    const { applyOperation } = await loadRegistryModule();
    script.start = { success: false, code: 'DEDUPED', error: DEDUPE_ERROR };
    script.statuses = [
      [{ name: 'jarvis-mls', pid: 811, sessionStart: '2026-09-05T11:00:00Z', status: 'running' }],
    ];

    const receipt = await applyOperation(
      { kind: 'switch', role: 'listing_intel', tier: 'economy', actor: 'scott', reason: 'defect 6' },
      { ...ctx(), restartConfirmMs: 600 },
    );

    expect(receipt.state).toBe('blocked');
    expect(receipt.error).toMatch(/no fresh session/);
  });
});
