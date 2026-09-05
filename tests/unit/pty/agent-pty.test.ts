import { describe, it, expect, vi } from 'vitest';

// node-pty is native; stub it so constructing AgentPTY never touches it.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

// existsSync=false → the local/*.md system-prompt block is skipped in buildClaudeArgs.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
} as any;

function argsFor(config: any, mode: 'fresh' | 'continue' = 'fresh'): string[] {
  const pty = new AgentPTY(mockEnv, config);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs(mode, 'PROMPT');
}

describe('AgentPTY --dangerously-skip-permissions toggle', () => {
  it('includes the flag by default (back-compat: skip stays ON)', () => {
    expect(argsFor({})).toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly true', () => {
    expect(argsFor({ dangerously_skip_permissions: true })).toContain('--dangerously-skip-permissions');
  });

  it('does NOT include the flag when dangerously_skip_permissions is false (permission gate engaged)', () => {
    expect(argsFor({ dangerously_skip_permissions: false })).not.toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly undefined (treated as default)', () => {
    expect(argsFor({ dangerously_skip_permissions: undefined })).toContain('--dangerously-skip-permissions');
  });

  it('fails safe (keeps the flag) and warns on a non-boolean value, e.g. the string "false"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A typo'd string must NOT silently disable the skip flag.
      expect(argsFor({ dangerously_skip_permissions: 'false' as any })).toContain('--dangerously-skip-permissions');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('AgentPTY session id (model-routing provenance)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('pins a session id on a fresh spawn so the transcript is attributable', () => {
    // Several agents share a working directory, so the cwd slug alone cannot
    // say whose transcript is whose. The session id can.
    const pty = new AgentPTY(mockEnv, {} as any);
    const args = (pty as any).buildClaudeArgs('fresh', 'PROMPT') as string[];
    const idx = args.indexOf('--session-id');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toMatch(UUID);
    expect(pty.getSessionId()).toBe(args[idx + 1]);
  });

  it('gives each fresh spawn its own session id', () => {
    const a = new AgentPTY(mockEnv, {} as any);
    const b = new AgentPTY(mockEnv, {} as any);
    (a as any).buildClaudeArgs('fresh', 'PROMPT');
    (b as any).buildClaudeArgs('fresh', 'PROMPT');
    expect(a.getSessionId()).not.toBe(b.getSessionId());
  });

  it('does not force a session id on --continue (the CLI resumes its own)', () => {
    const pty = new AgentPTY(mockEnv, {} as any);
    const args = (pty as any).buildClaudeArgs('continue', 'PROMPT') as string[];
    expect(args).toContain('--continue');
    expect(args).not.toContain('--session-id');
    expect(pty.getSessionId()).toBeNull();
  });
});
