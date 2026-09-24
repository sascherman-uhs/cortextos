import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let socketExists = false;

const fsMocks = {
  existsSync: vi.fn((p: string) => (String(p).includes('codex.sock') ? socketExists : false)),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  appendFileSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
  };
});

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

const requestMock = vi.fn();

vi.mock('../../../src/utils/ws-unix-client.js', () => ({
  WsUnixJsonRpcClient: vi.fn().mockImplementation(function WsUnixJsonRpcClient() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      notify: vi.fn(),
      respondError: vi.fn(),
      onMessage: vi.fn().mockReturnValue(vi.fn()),
      request: requestMock,
    };
  }),
}));

vi.mock('../../../src/bus/event.js', () => ({ logEvent: vi.fn() }));

const { CodexAppServerPTY } = await import('../../../src/pty/codex-app-server-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-app-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-app-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

function fakePty(onExitSink: Array<(e: { exitCode: number; signal?: number }) => void>) {
  return {
    pid: 1234,
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => { onExitSink.push(cb); }),
    kill: vi.fn(),
  };
}

beforeEach(() => {
  socketExists = false;
  requestMock.mockReset().mockResolvedValue({ result: { thread: { id: 'thread-1' } } });
  process.env['CTX_CODEX_SOCKET_WAIT_MS'] = '50';
});

afterEach(() => {
  delete process.env['CTX_CODEX_SOCKET_WAIT_MS'];
});

describe('CodexAppServerPTY spawn retry vs the dead-RPC gate (fleet-stability A2)', () => {
  it('still starts when the FIRST app-server attempt dies and the second succeeds', async () => {
    const p = new CodexAppServerPTY(mockEnv, {});
    const exits: Array<(e: { exitCode: number; signal?: number }) => void> = [];
    let attempts = 0;
    (p as unknown as { _spawnFn: unknown })._spawnFn = () => {
      attempts += 1;
      const pty = fakePty(exits);
      if (attempts === 1) {
        // Attempt 1's app-server dies on its own — the crash path, which is
        // exactly trillion-coder's failure mode. onExit fires while
        // _appServerPty still points at this pty, so it sets _alive = false.
        setTimeout(() => exits[0]?.({ exitCode: 1 }), 0);
      } else {
        socketExists = true;
      }
      return pty;
    };

    await p.spawn('fresh', '');

    expect(attempts).toBe(2);
    expect(p.isAlive()).toBe(true);
    expect(requestMock).toHaveBeenCalledWith('initialize', expect.anything());
  }, 20000);
});
